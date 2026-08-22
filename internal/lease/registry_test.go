package lease

import (
	"testing"
	"time"
)

type fakeClock struct{ now time.Time }

func (c *fakeClock) Now() time.Time { return c.now }

func TestAcquireRenewExpiryAndRelease(t *testing.T) {
	clock := &fakeClock{now: time.Unix(100, 0)}
	registry := New(clock, 10*time.Second)
	first, err := registry.Acquire("session", "laptop")
	if err != nil {
		t.Fatalf("Acquire() error = %v", err)
	}
	if _, err := registry.Acquire("session", "other"); !IsActive(err) {
		t.Fatalf("second Acquire() error = %v, want active", err)
	}
	clock.now = clock.now.Add(5 * time.Second)
	renewed, err := registry.Renew("session", first.Token)
	if err != nil {
		t.Fatalf("Renew() error = %v", err)
	}
	if !renewed.ExpiresAt.Equal(time.Unix(115, 0)) {
		t.Fatalf("renewed expiry = %v", renewed.ExpiresAt)
	}
	clock.now = clock.now.Add(11 * time.Second)
	if _, ok := registry.Current("session"); ok {
		t.Fatal("expired lease remains current")
	}
	if err := registry.Release("session", first.Token); !IsNotFound(err) {
		t.Fatalf("Release() error = %v, want not found", err)
	}
}

func TestInvalidTokenDoesNotRelease(t *testing.T) {
	clock := &fakeClock{now: time.Unix(100, 0)}
	registry := New(clock, time.Minute)
	value, err := registry.Acquire("session", "client")
	if err != nil {
		t.Fatal(err)
	}
	if err := registry.Release("session", "wrong"); !IsInvalidToken(err) {
		t.Fatalf("Release() error = %v", err)
	}
	if _, ok := registry.Current(value.SessionID); !ok {
		t.Fatal("invalid release removed the lease")
	}
	registry.Reset()
	if _, ok := registry.Current(value.SessionID); ok {
		t.Fatal("Reset() retained lease")
	}
}
