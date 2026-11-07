//go:build !windows

package auth

import (
	"errors"
	"os"
	"syscall"
)

// tryLock takes an exclusive lock on file without waiting. False means another holder has it.
func tryLock(file *os.File) (bool, error) {
	err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
		return false, nil
	}
	return false, err
}

func unlock(file *os.File) error { return syscall.Flock(int(file.Fd()), syscall.LOCK_UN) }
