package lease

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"sync"
	"time"
)

const (
	DefaultHeartbeat = 20 * time.Second
	DefaultExpiry    = 120 * time.Second
)

var (
	ErrActive       = errors.New("session lease is active")
	ErrInvalidToken = errors.New("lease token is invalid or expired")
	ErrNotFound     = errors.New("lease not found")
)

type Clock interface {
	Now() time.Time
}

type RealClock struct{}

func (RealClock) Now() time.Time { return time.Now() }

type Lease struct {
	SessionID  string    `json:"sessionId"`
	Token      string    `json:"-"`
	Holder     string    `json:"holder"`
	AcquiredAt time.Time `json:"acquiredAt"`
	ExpiresAt  time.Time `json:"expiresAt"`
}

type Registry struct {
	mu       sync.Mutex
	leases   map[string]Lease
	clock    Clock
	duration time.Duration
}

func New(clock Clock, duration time.Duration) *Registry {
	if clock == nil {
		clock = RealClock{}
	}
	if duration <= 0 {
		duration = DefaultExpiry
	}
	return &Registry{leases: make(map[string]Lease), clock: clock, duration: duration}
}

func (r *Registry) Acquire(sessionID, holder string) (Lease, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.clock.Now()
	r.removeExpiredLocked(now)
	if current, ok := r.leases[sessionID]; ok {
		return current, ErrActive
	}
	token, err := newToken()
	if err != nil {
		return Lease{}, err
	}
	lease := Lease{
		SessionID:  sessionID,
		Token:      token,
		Holder:     sanitizeHolder(holder),
		AcquiredAt: now,
		ExpiresAt:  now.Add(r.duration),
	}
	r.leases[sessionID] = lease
	return lease, nil
}

func (r *Registry) Renew(sessionID, token string) (Lease, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.clock.Now()
	current, ok := r.leases[sessionID]
	if !ok || !sameToken(current.Token, token) || !now.Before(current.ExpiresAt) {
		if ok && !now.Before(current.ExpiresAt) {
			delete(r.leases, sessionID)
		}
		return Lease{}, ErrInvalidToken
	}
	current.ExpiresAt = now.Add(r.duration)
	r.leases[sessionID] = current
	return current, nil
}

func (r *Registry) Release(sessionID, token string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.clock.Now()
	current, ok := r.leases[sessionID]
	if !ok {
		return ErrNotFound
	}
	if !now.Before(current.ExpiresAt) {
		delete(r.leases, sessionID)
		return ErrInvalidToken
	}
	if !sameToken(current.Token, token) {
		return ErrInvalidToken
	}
	delete(r.leases, sessionID)
	return nil
}

func (r *Registry) Current(sessionID string) (Lease, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.removeExpiredLocked(r.clock.Now())
	lease, ok := r.leases[sessionID]
	return lease, ok
}

func (r *Registry) Reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.leases = make(map[string]Lease)
}

func (r *Registry) removeExpiredLocked(now time.Time) {
	for id, current := range r.leases {
		if !now.Before(current.ExpiresAt) {
			delete(r.leases, id)
		}
	}
}

func newToken() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

func sameToken(left, right string) bool {
	// Tokens are random and never persisted in sessions. A direct comparison is
	// sufficient here; the API only exposes the token to the current client.
	return left != "" && right != "" && len(left) == len(right) && subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func sanitizeHolder(holder string) string {
	if len(holder) > 128 {
		holder = holder[:128]
	}
	for index, character := range holder {
		if character == '\r' || character == '\n' || character == 0 {
			return "client"
		}
		if index == 0 && character == 0 {
			return "client"
		}
	}
	if holder == "" {
		return "client"
	}
	return holder
}

func IsActive(err error) bool       { return errors.Is(err, ErrActive) }
func IsInvalidToken(err error) bool { return errors.Is(err, ErrInvalidToken) }
func IsNotFound(err error) bool     { return errors.Is(err, ErrNotFound) }
