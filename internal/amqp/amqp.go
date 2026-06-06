// Package amqp wraps the RabbitMQ topology and publish/consume helpers used by
// the data plane. The work queue lives here (not Postgres); jobs carry only
// references. Queues are quorum queues per the spec.
package amqp

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"

	"github.com/azrtydxb/novamail/internal/model"
)

const (
	// WorkExchange is a topic exchange keyed on recipient domain so a throttled
	// domain can get its own bound queue without head-of-line-blocking others.
	WorkExchange = "relay.work"
	// WorkQueue is the single catch-all delivery queue for M1 (per-domain
	// queues arrive with the routing engine in M3).
	WorkQueue = "relay.work.q"
	// DLQ holds permanently-failed messages; the DSN generator consumes it.
	DLQ = "relay.dlq"
	// ConfigExchange is the fanout the Admin API publishes config.changed events
	// to; each data-plane service binds an exclusive queue and hot-reloads.
	ConfigExchange = "config.changed"
)

// WaitTier is a retry backoff stage: a queue with a message TTL whose dead
// letters route back to relay.work for another delivery attempt.
type WaitTier struct {
	Queue string
	TTL   time.Duration
}

// WaitTiers defines the backoff schedule (spec §6). A deferred message escalates
// through these in order; exhausting them dead-letters to the DLQ.
var WaitTiers = []WaitTier{
	{Queue: "wait.30s", TTL: 30 * time.Second},
	{Queue: "wait.5m", TTL: 5 * time.Minute},
	{Queue: "wait.30m", TTL: 30 * time.Minute},
}

// TierForAttempt returns the wait tier for the given (already-incremented)
// attempt number, and ok=false when the schedule is exhausted (→ DLQ).
func TierForAttempt(attempt int) (WaitTier, bool) {
	idx := attempt - 1
	if idx < 0 || idx >= len(WaitTiers) {
		return WaitTier{}, false
	}
	return WaitTiers[idx], true
}

// Conn is a RabbitMQ connection with a channel for the data plane.
type Conn struct {
	conn *amqp.Connection
	ch   *amqp.Channel
}

// Dial connects and declares the relay topology (idempotent).
func Dial(url string) (*Conn, error) {
	conn, err := amqp.Dial(url)
	if err != nil {
		return nil, fmt.Errorf("amqp dial: %w", err)
	}
	ch, err := conn.Channel()
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("amqp channel: %w", err)
	}
	if err := declare(ch); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return &Conn{conn: conn, ch: ch}, nil
}

func declare(ch *amqp.Channel) error {
	if err := ch.ExchangeDeclare(WorkExchange, "topic", true, false, false, false, nil); err != nil {
		return fmt.Errorf("declare exchange: %w", err)
	}
	if _, err := ch.QueueDeclare(WorkQueue, true, false, false, false, amqp.Table{
		"x-queue-type": "quorum",
	}); err != nil {
		return fmt.Errorf("declare queue: %w", err)
	}
	// "#" binds every recipient-domain routing key (and dead-lettered retries).
	if err := ch.QueueBind(WorkQueue, "#", WorkExchange, false, nil); err != nil {
		return fmt.Errorf("bind queue: %w", err)
	}

	// Retry tiers: each wait queue holds a message for its TTL, then dead-letters
	// back to relay.work for another delivery attempt (pure core AMQP, no plugins).
	for _, t := range WaitTiers {
		if _, err := ch.QueueDeclare(t.Queue, true, false, false, false, amqp.Table{
			"x-queue-type":             "quorum",
			"x-message-ttl":            int64(t.TTL / time.Millisecond),
			"x-dead-letter-exchange":   WorkExchange,
			"x-dead-letter-routing-key": "retry",
		}); err != nil {
			return fmt.Errorf("declare %s: %w", t.Queue, err)
		}
	}

	// Permanent failures land here for the DSN generator.
	if _, err := ch.QueueDeclare(DLQ, true, false, false, false, amqp.Table{
		"x-queue-type": "quorum",
	}); err != nil {
		return fmt.Errorf("declare dlq: %w", err)
	}
	return nil
}

// Requeue publishes a job (with its incremented Attempt) onto a wait tier via
// the default exchange; it dead-letters back to relay.work when the TTL expires.
func (c *Conn) Requeue(ctx context.Context, tier WaitTier, job *model.RelayJob) error {
	return c.publishToQueue(ctx, tier.Queue, job)
}

// DeadLetter publishes a permanently-failed job to the DLQ.
func (c *Conn) DeadLetter(ctx context.Context, job *model.RelayJob) error {
	return c.publishToQueue(ctx, DLQ, job)
}

func (c *Conn) publishToQueue(ctx context.Context, queue string, job *model.RelayJob) error {
	body, err := json.Marshal(job)
	if err != nil {
		return fmt.Errorf("marshal job: %w", err)
	}
	// Default exchange routes by queue name.
	return c.ch.PublishWithContext(ctx, "", queue, false, false, amqp.Publishing{
		ContentType:  "application/json",
		DeliveryMode: amqp.Persistent,
		MessageId:    job.MessageID,
		Body:         body,
	})
}

// ConsumeQueue consumes an arbitrary queue with manual acks (used by the DSN
// generator for the DLQ).
func (c *Conn) ConsumeQueue(queue string, prefetch int) (<-chan amqp.Delivery, error) {
	if err := c.ch.Qos(prefetch, 0, false); err != nil {
		return nil, fmt.Errorf("qos: %w", err)
	}
	d, err := c.ch.Consume(queue, "", false, false, false, false, nil)
	if err != nil {
		return nil, fmt.Errorf("consume %s: %w", queue, err)
	}
	return d, nil
}

// Publish serialises a job and publishes it keyed on the recipient domain.
func (c *Conn) Publish(ctx context.Context, job *model.RelayJob) error {
	body, err := json.Marshal(job)
	if err != nil {
		return fmt.Errorf("marshal job: %w", err)
	}
	return c.ch.PublishWithContext(ctx, WorkExchange, job.RoutingHints.RecipientDomain, false, false,
		amqp.Publishing{
			ContentType:  "application/json",
			DeliveryMode: amqp.Persistent,
			MessageId:    job.MessageID,
			Body:         body,
		})
}

// Consume returns a delivery channel for the work queue with manual acks.
// prefetch bounds in-flight messages per consumer (QoS).
func (c *Conn) Consume(prefetch int) (<-chan amqp.Delivery, error) {
	if err := c.ch.Qos(prefetch, 0, false); err != nil {
		return nil, fmt.Errorf("qos: %w", err)
	}
	d, err := c.ch.Consume(WorkQueue, "", false, false, false, false, nil)
	if err != nil {
		return nil, fmt.Errorf("consume: %w", err)
	}
	return d, nil
}

// PublishConfig publishes a config.changed event to the fanout exchange.
func (c *Conn) PublishConfig(ctx context.Context, body []byte) error {
	if err := c.ch.ExchangeDeclare(ConfigExchange, "fanout", true, false, false, false, nil); err != nil {
		return fmt.Errorf("declare config exchange: %w", err)
	}
	return c.ch.PublishWithContext(ctx, ConfigExchange, "", false, false, amqp.Publishing{
		ContentType:  "application/json",
		DeliveryMode: amqp.Transient,
		Body:         body,
	})
}

// SubscribeConfig binds an exclusive, auto-delete queue to the config fanout and
// invokes handler with each event body. It opens its own channel so it does not
// interfere with the work-queue consumer's QoS. Runs until the connection closes.
func (c *Conn) SubscribeConfig(handler func([]byte)) error {
	ch, err := c.conn.Channel()
	if err != nil {
		return fmt.Errorf("config channel: %w", err)
	}
	if err := ch.ExchangeDeclare(ConfigExchange, "fanout", true, false, false, false, nil); err != nil {
		return fmt.Errorf("declare config exchange: %w", err)
	}
	q, err := ch.QueueDeclare("", false, true, true, false, nil) // exclusive, auto-delete
	if err != nil {
		return fmt.Errorf("declare config queue: %w", err)
	}
	if err := ch.QueueBind(q.Name, "", ConfigExchange, false, nil); err != nil {
		return fmt.Errorf("bind config queue: %w", err)
	}
	msgs, err := ch.Consume(q.Name, "", true, true, false, false, nil) // autoAck, exclusive
	if err != nil {
		return fmt.Errorf("consume config: %w", err)
	}
	go func() {
		for m := range msgs {
			handler(m.Body)
		}
	}()
	return nil
}

// Ping reports whether the channel/connection is usable (for readiness).
func (c *Conn) Ping() error {
	if c.conn == nil || c.conn.IsClosed() {
		return fmt.Errorf("amqp connection closed")
	}
	return nil
}

func (c *Conn) Close() error {
	if c.conn != nil {
		return c.conn.Close()
	}
	return nil
}
