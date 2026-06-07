// Package amqp wraps the RabbitMQ topology and publish/consume helpers used by
// the data plane. The work queue lives here (not Postgres); jobs carry only
// references. Queues are quorum queues per the spec.
package amqp

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"
	"sync/atomic"
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

// consumer is a registered subscription, re-established on every reconnect. out
// is the stable channel handed to the caller; it never closes across reconnects
// so the caller's range loop survives a broker restart.
type consumer struct {
	queue    string
	prefetch int
	out      chan amqp.Delivery
}

// Conn is a self-healing RabbitMQ connection for the data plane. amqp091 does
// not auto-reconnect, so a supervisor watches the connection and, on loss,
// redials with backoff, re-declares the topology, and re-establishes every
// registered consumer + config subscription. Publishers retry across the gap.
type Conn struct {
	url string
	log *slog.Logger

	mu   sync.RWMutex // guards conn/ch (swapped on reconnect)
	conn *amqp.Connection
	ch   *amqp.Channel

	closed atomic.Bool

	regMu          sync.Mutex // guards the registries below
	consumers      []*consumer
	configHandlers []func([]byte)
}

// Dial connects, declares the relay topology, and starts the reconnect
// supervisor. For an amqps:// URL it builds a TLS config from the mounted CA
// (+ client cert for mutual TLS) so the bus connection is verified and
// client-authenticated.
func Dial(url string, log *slog.Logger) (*Conn, error) {
	if log == nil {
		log = slog.Default()
	}
	c := &Conn{url: url, log: log}
	if err := c.connect(); err != nil {
		return nil, err
	}
	go c.supervise()
	return c, nil
}

// connect (re)establishes the connection + channel and re-declares the topology.
func (c *Conn) connect() error {
	conn, err := dialBus(c.url)
	if err != nil {
		return fmt.Errorf("amqp dial: %w", err)
	}
	ch, err := conn.Channel()
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("amqp channel: %w", err)
	}
	if err := declare(ch); err != nil {
		_ = conn.Close()
		return err
	}
	c.mu.Lock()
	c.conn, c.ch = conn, ch
	c.mu.Unlock()
	return nil
}

// supervise blocks on the current connection's close notification and, unless
// the close was intentional (Close), reconnects and re-establishes everything.
func (c *Conn) supervise() {
	for !c.closed.Load() {
		c.mu.RLock()
		conn := c.conn
		c.mu.RUnlock()
		if conn == nil {
			return
		}
		err := <-conn.NotifyClose(make(chan *amqp.Error, 1))
		if c.closed.Load() {
			return
		}
		c.log.Warn("amqp connection lost; reconnecting", "err", err)
		c.reconnect()
		if c.closed.Load() {
			return
		}
		c.log.Info("amqp reconnected")
	}
}

// reconnect retries connect() with capped exponential backoff, then rebuilds all
// subscriptions on the fresh channel.
func (c *Conn) reconnect() {
	backoff := time.Second
	for !c.closed.Load() {
		if err := c.connect(); err != nil {
			c.log.Warn("amqp reconnect failed", "err", err, "retry_in", backoff.String())
			time.Sleep(backoff)
			if backoff < 30*time.Second {
				backoff *= 2
			}
			continue
		}
		c.reestablish()
		return
	}
}

// reestablish re-subscribes every registered consumer + config handler after a
// reconnect (their old channels died with the old connection).
func (c *Conn) reestablish() {
	c.regMu.Lock()
	defer c.regMu.Unlock()
	for _, cs := range c.consumers {
		if err := c.startConsumer(cs); err != nil {
			c.log.Error("re-subscribe consumer failed", "queue", cs.queue, "err", err)
		}
	}
	for _, h := range c.configHandlers {
		if err := c.startConfigSub(h); err != nil {
			c.log.Error("re-subscribe config failed", "err", err)
		}
	}
}

// startConsumer opens a DEDICATED channel for the consumer (QoS is channel-scoped,
// so sharing one channel across consumers with different prefetch would let them
// clobber each other) and forwards each delivery to the consumer's stable out
// channel until the channel closes.
func (c *Conn) startConsumer(cs *consumer) error {
	c.mu.RLock()
	conn := c.conn
	c.mu.RUnlock()
	if conn == nil {
		return fmt.Errorf("no connection")
	}
	ch, err := conn.Channel()
	if err != nil {
		return fmt.Errorf("consumer channel: %w", err)
	}
	if err := ch.Qos(cs.prefetch, 0, false); err != nil {
		_ = ch.Close()
		return fmt.Errorf("qos: %w", err)
	}
	d, err := ch.Consume(cs.queue, "", false, false, false, false, nil)
	if err != nil {
		_ = ch.Close()
		return fmt.Errorf("consume %s: %w", cs.queue, err)
	}
	go func() {
		for msg := range d {
			cs.out <- msg
		}
		// d closed (disconnect or shutdown); the supervisor re-establishes.
	}()
	return nil
}

// dialBus dials plaintext amqp:// directly; for amqps:// it loads a TLS config
// from the mounted CA + (optional) client cert. Falls back to system roots if no
// CA is mounted.
func dialBus(url string) (*amqp.Connection, error) {
	if !strings.HasPrefix(url, "amqps://") {
		return amqp.Dial(url)
	}
	if tcfg := busTLS(); tcfg != nil {
		return amqp.DialTLS(url, tcfg)
	}
	return amqp.Dial(url)
}

// busTLS builds the bus TLS config from files under NOVAMAIL_AMQP_TLS_DIR
// (default /etc/novamail/amqptls): ca.crt to verify the broker, and tls.crt/
// tls.key to present a client cert (mutual TLS). Returns nil if no CA is mounted.
func busTLS() *tls.Config {
	dir := os.Getenv("NOVAMAIL_AMQP_TLS_DIR")
	if dir == "" {
		dir = "/etc/novamail/amqptls"
	}
	caPEM, err := os.ReadFile(dir + "/ca.crt")
	if err != nil {
		return nil
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil
	}
	server := os.Getenv("NOVAMAIL_AMQP_SERVERNAME")
	if server == "" {
		server = "nova-bus"
	}
	cfg := &tls.Config{RootCAs: pool, ServerName: server, MinVersion: tls.VersionTLS12}
	if cert, err := tls.LoadX509KeyPair(dir+"/tls.crt", dir+"/tls.key"); err == nil {
		cfg.Certificates = []tls.Certificate{cert} // mutual TLS
	}
	return cfg
}

func declare(ch *amqp.Channel) error {
	if err := ch.ExchangeDeclare(WorkExchange, "topic", true, false, false, false, nil); err != nil {
		return fmt.Errorf("declare exchange: %w", err)
	}
	// Declare the config fanout here too so a publisher that fires immediately
	// after a reconnect (before any subscriber recreates it) doesn't hit NOT_FOUND.
	if err := ch.ExchangeDeclare(ConfigExchange, "fanout", true, false, false, false, nil); err != nil {
		return fmt.Errorf("declare config exchange: %w", err)
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

// publish sends on the current channel, retrying across a reconnect: if the
// channel is gone, it waits briefly for the supervisor to re-establish it and
// tries again, until the caller's context expires.
func (c *Conn) publish(ctx context.Context, exchange, key string, pub amqp.Publishing) error {
	var lastErr error
	for {
		c.mu.RLock()
		ch := c.ch
		c.mu.RUnlock()
		if ch != nil {
			if err := ch.PublishWithContext(ctx, exchange, key, false, false, pub); err == nil {
				return nil
			} else {
				lastErr = err
			}
		}
		// Retry until the caller's context expires (callers pass a per-message
		// deadline), so a publish survives a broker restart rather than failing
		// after a fixed budget and leaving a body persisted but never enqueued.
		select {
		case <-ctx.Done():
			if lastErr == nil {
				lastErr = ctx.Err()
			}
			return fmt.Errorf("publish to %q: %w", exchange+"/"+key, lastErr)
		case <-time.After(500 * time.Millisecond): // wait for the supervisor to reconnect
		}
	}
}

func jobPublishing(job *model.RelayJob) (amqp.Publishing, error) {
	body, err := json.Marshal(job)
	if err != nil {
		return amqp.Publishing{}, fmt.Errorf("marshal job: %w", err)
	}
	return amqp.Publishing{
		ContentType:  "application/json",
		DeliveryMode: amqp.Persistent,
		MessageId:    job.MessageID,
		Body:         body,
	}, nil
}

// Requeue publishes a job (with its incremented Attempt) onto a wait tier via
// the default exchange; it dead-letters back to relay.work when the TTL expires.
func (c *Conn) Requeue(ctx context.Context, tier WaitTier, job *model.RelayJob) error {
	pub, err := jobPublishing(job)
	if err != nil {
		return err
	}
	return c.publish(ctx, "", tier.Queue, pub) // default exchange routes by queue name
}

// DeadLetter publishes a permanently-failed job to the DLQ.
func (c *Conn) DeadLetter(ctx context.Context, job *model.RelayJob) error {
	pub, err := jobPublishing(job)
	if err != nil {
		return err
	}
	return c.publish(ctx, "", DLQ, pub)
}

// Publish serialises a job and publishes it keyed on the recipient domain.
func (c *Conn) Publish(ctx context.Context, job *model.RelayJob) error {
	pub, err := jobPublishing(job)
	if err != nil {
		return err
	}
	return c.publish(ctx, WorkExchange, job.RoutingHints.RecipientDomain, pub)
}

// ConsumeQueue consumes an arbitrary queue with manual acks (used by the DSN
// generator for the DLQ). The returned channel survives broker reconnects.
func (c *Conn) ConsumeQueue(queue string, prefetch int) (<-chan amqp.Delivery, error) {
	return c.registerConsumer(queue, prefetch)
}

// Consume returns a delivery channel for the work queue with manual acks.
// prefetch bounds in-flight messages per consumer (QoS). The channel survives
// broker reconnects (it stays open across reconnects so the consumer loop does
// not exit on a RabbitMQ restart). Shut the consumer down via its context, not by
// waiting for the channel to close — Close() tears down the connection but does
// not close these out channels (closing them could panic concurrent forwarders).
func (c *Conn) Consume(prefetch int) (<-chan amqp.Delivery, error) {
	return c.registerConsumer(WorkQueue, prefetch)
}

func (c *Conn) registerConsumer(queue string, prefetch int) (<-chan amqp.Delivery, error) {
	cs := &consumer{queue: queue, prefetch: prefetch, out: make(chan amqp.Delivery, prefetch)}
	// Hold regMu across start+append: this serialises against reestablish() (which
	// also holds regMu), so a reconnect can't slip between a successful start and
	// registration and miss re-subscribing this consumer. Register only on success,
	// so a failed subscription isn't left in the registry behind the caller's back.
	c.regMu.Lock()
	defer c.regMu.Unlock()
	if err := c.startConsumer(cs); err != nil {
		return nil, err
	}
	c.consumers = append(c.consumers, cs)
	return cs.out, nil
}

// PublishConfig publishes a config.changed event to the fanout exchange. The
// exchange is declared by declare() on every (re)connect, so no per-publish
// declare (whose error we'd have to swallow) is needed here.
func (c *Conn) PublishConfig(ctx context.Context, body []byte) error {
	return c.publish(ctx, ConfigExchange, "", amqp.Publishing{
		ContentType:  "application/json",
		DeliveryMode: amqp.Transient,
		Body:         body,
	})
}

// SubscribeConfig binds an exclusive, auto-delete queue to the config fanout and
// invokes handler with each event body. The subscription is re-established on
// every reconnect, so config hot-reload survives a broker restart.
func (c *Conn) SubscribeConfig(handler func([]byte)) error {
	c.regMu.Lock()
	c.configHandlers = append(c.configHandlers, handler)
	c.regMu.Unlock()
	return c.startConfigSub(handler)
}

func (c *Conn) startConfigSub(handler func([]byte)) error {
	c.mu.RLock()
	conn := c.conn
	c.mu.RUnlock()
	if conn == nil {
		return fmt.Errorf("no connection")
	}
	ch, err := conn.Channel() // own channel so it does not share the work-queue QoS
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

// Ping reports whether the connection is usable (for readiness). During a
// reconnect this returns an error, so the pod is briefly marked NotReady (but
// not restarted — liveness does not check the bus) and recovers on reconnect.
func (c *Conn) Ping() error {
	c.mu.RLock()
	conn := c.conn
	c.mu.RUnlock()
	if conn == nil || conn.IsClosed() {
		return fmt.Errorf("amqp connection closed")
	}
	return nil
}

// Close stops the supervisor and closes the connection.
func (c *Conn) Close() error {
	c.closed.Store(true)
	c.mu.RLock()
	conn := c.conn
	c.mu.RUnlock()
	if conn != nil {
		return conn.Close()
	}
	return nil
}
