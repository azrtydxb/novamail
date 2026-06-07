// Package tracing wires OpenTelemetry traces for the data-plane services. It
// exports OTLP/gRPC to the endpoint in OTEL_EXPORTER_OTLP_ENDPOINT (the cluster
// Jaeger), and is a no-op when that is unset so the binaries run fine without it.
//
// Trace context is carried between services inside the relay job (Inject/Extract
// on a string map), so a message's spans link ingress → delivery end to end even
// across the RabbitMQ hop and the retry/wait tiers.
package tracing

import (
	"context"
	"log/slog"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

// Init installs a global TracerProvider exporting to OTEL_EXPORTER_OTLP_ENDPOINT
// (host:port, gRPC, insecure — in-cluster). Returns a shutdown func to flush on
// exit and the service tracer. With no endpoint set it returns a no-op tracer.
func Init(ctx context.Context, service string, log *slog.Logger) (func(context.Context) error, trace.Tracer) {
	noop := func(context.Context) error { return nil }
	endpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	if endpoint == "" {
		return noop, otel.Tracer(service)
	}
	exp, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithEndpoint(endpoint),
		otlptracegrpc.WithInsecure(),
	)
	if err != nil {
		log.Warn("tracing disabled: OTLP exporter init failed", "endpoint", endpoint, "err", err)
		return noop, otel.Tracer(service)
	}
	res, _ := resource.New(ctx, resource.WithAttributes(semconv.ServiceName(service)))
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{},
	))
	log.Info("tracing enabled", "endpoint", endpoint, "service", service)
	return tp.Shutdown, tp.Tracer(service)
}

// Inject serialises the current span context into a string map to ride along in
// the relay job (nil if there is no active span context).
func Inject(ctx context.Context) map[string]string {
	c := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(ctx, c)
	if len(c) == 0 {
		return nil
	}
	return c
}

// Extract returns ctx with the span context recovered from a job's carrier.
func Extract(ctx context.Context, carrier map[string]string) context.Context {
	if len(carrier) == 0 {
		return ctx
	}
	return otel.GetTextMapPropagator().Extract(ctx, propagation.MapCarrier(carrier))
}
