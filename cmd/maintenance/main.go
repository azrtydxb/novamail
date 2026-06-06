// Command maintenance is a one-shot retention sweep run as a Kubernetes CronJob:
// it prunes terminal messages/events past the retention window and removes
// orphaned body files (no longer referenced by a live message). It exits 0 on
// success so the CronJob reports completion.
package main

import (
	"context"
	"log/slog"
	"os"
	"time"

	"github.com/azrtydxb/novamail/internal/db"
	"github.com/azrtydxb/novamail/internal/store"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	database, err := db.Open(ctx, os.Getenv("DSN"))
	if err != nil {
		logger.Error("init postgres", "err", err)
		os.Exit(1)
	}
	defer database.Close()

	bodies, err := store.NewFSStore(env("NOVAMAIL_BODY_STORE", "/var/lib/novamail/bodies"))
	if err != nil {
		logger.Error("init body store", "err", err)
		os.Exit(1)
	}

	days := int(database.GetSettingInt(ctx, "retention_days", 30))
	pruned, err := database.PruneOld(ctx, days)
	if err != nil {
		logger.Error("prune messages", "err", err)
	}

	active, err := database.ActiveBodyRefs(ctx)
	if err != nil {
		logger.Error("active body refs", "err", err)
		active = map[string]bool{} // avoid deleting everything on query failure
		os.Exit(1)
	}
	var swept int
	if walkErr := bodies.Walk(func(id string) {
		if !active[id] {
			if derr := bodies.Delete(ctx, id); derr == nil {
				swept++
			}
		}
	}); walkErr != nil {
		logger.Error("sweep bodies", "err", walkErr)
	}

	logger.Info("maintenance complete", "retentionDays", days, "messagesPruned", pruned, "orphanBodiesSwept", swept)
}
