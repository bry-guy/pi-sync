package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/bry-guy/pi-sync/internal/api"
	"github.com/bry-guy/pi-sync/internal/lease"
	"github.com/bry-guy/pi-sync/internal/store"
)

func main() {
	listen := os.Getenv("PI_SYNC_LISTEN")
	if listen == "" {
		listen = "127.0.0.1:8080"
	}
	dataDir := os.Getenv("PI_SYNC_DATA_DIR")
	if dataDir == "" {
		dataDir = ".pi-sync-data"
	}

	filesystem, err := store.New(dataDir)
	if err != nil {
		log.Fatalf("initialize store: %v", err)
	}
	leases := lease.New(lease.RealClock{}, lease.DefaultExpiry)
	retention, err := retentionFromEnv(os.Getenv("PI_SYNC_RETENTION_DAYS"))
	if err != nil {
		log.Fatalf("PI_SYNC_RETENTION_DAYS: %v", err)
	}
	go maintain(filesystem, leases, retention)
	handler := api.New(filesystem, leases)
	server := &http.Server{
		Addr:              listen,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	go func() {
		<-shutdown
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("graceful shutdown failed: %v", err)
		}
	}()

	log.Printf("pi-syncd listening on %s", listen)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("serve: %v", err)
	}
}

// retentionFromEnv reads the days a conversation may stay inactive before its entries are deleted; 0 keeps them forever.
func retentionFromEnv(value string) (time.Duration, error) {
	if value == "" {
		return 14 * 24 * time.Hour, nil
	}
	days, err := strconv.Atoi(value)
	if err != nil || days < 0 {
		return 0, fmt.Errorf("must be a whole number of days (0 keeps conversations forever)")
	}
	return time.Duration(days) * 24 * time.Hour, nil
}

// maintain counts usage stored before the ledger existed, then deletes inactive conversations hourly.
func maintain(filesystem *store.Store, leases *lease.Registry, retention time.Duration) {
	if err := filesystem.CountAllUsage(); err != nil {
		log.Printf("count usage: %v", err)
	}
	if retention == 0 {
		return
	}
	held := func(id string) bool { _, ok := leases.Current(id); return ok }
	for {
		deleted, err := filesystem.Sweep(retention, time.Now(), held)
		if err != nil {
			log.Printf("retention sweep: %v", err)
		}
		for _, id := range deleted {
			log.Printf("deleted inactive conversation %s", id)
		}
		time.Sleep(time.Hour)
	}
}
