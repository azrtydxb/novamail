// Package amqp wraps the RabbitMQ topology and publish/consume helpers used by
// the data plane. The work queue lives here (not Postgres); jobs carry only
// references. Queues are quorum queues per the spec.
package amqp

import (
	"context"
	"encoding/json"
	"fmt"

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
)

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
	// "#" binds every recipient-domain routing key for now.
	if err := ch.QueueBind(WorkQueue, "#", WorkExchange, false, nil); err != nil {
		return fmt.Errorf("bind queue: %w", err)
	}
	return nil
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
