package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
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
