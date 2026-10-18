// SPDX-License-Identifier: GPL-2.0-or-later
//! x11rb's socket with a deadline for its waits. x11rb's own stream waits
//! for the server without end (so does Xlib); a server that stops answering,
//! or answers a byte at a time, would otherwise hold the analytics flush. The
//! deadline covers a whole lookup (and the connection setup before it), not
//! each wait.

use std::io::{self, IoSlice};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::fd::AsFd;
use rustix::io::Errno;
use x11rb::rust_connection::{DefaultStream, PollMode, Stream};
use x11rb::utils::RawFdContainer;

/// How long one lookup, or opening the connection, may wait on the server.
pub(super) const LOOKUP_TIMEOUT: Duration = Duration::from_secs(2);

/// A [`DefaultStream`] whose waits fail with `TimedOut` once the deadline
/// has passed; reads and writes are its own.
pub(crate) struct TimedStream {
    inner: DefaultStream,
    deadline: Mutex<Instant>,
}

impl TimedStream {
    pub fn new(inner: DefaultStream, deadline: Instant) -> Self {
        Self { inner, deadline: Mutex::new(deadline) }
    }

    /// Sets the deadline of the waits from now on.
    pub fn set_deadline(&self, deadline: Instant) {
        *self.deadline.lock().unwrap_or_else(PoisonError::into_inner) = deadline;
    }

    fn remaining(&self) -> Duration {
        self.deadline.lock().unwrap_or_else(PoisonError::into_inner).saturating_duration_since(Instant::now())
    }
}

fn timed_out() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "the X server did not answer in time")
}

impl Stream for TimedStream {
    fn poll(&self, mode: PollMode) -> io::Result<()> {
        let mut flags = PollFlags::empty();
        if mode.readable() {
            flags |= PollFlags::IN;
        }
        if mode.writable() {
            flags |= PollFlags::OUT;
        }
        let mut fds = [PollFd::from_borrowed_fd(self.inner.as_fd(), flags)];
        loop {
            let remaining = self.remaining();
            if remaining.is_zero() {
                return Err(timed_out());
            }
            let timeout = Timespec {
                tv_sec: remaining.as_secs().try_into().unwrap_or(i64::MAX),
                tv_nsec: remaining.subsec_nanos().into(),
            };
            match poll(&mut fds, Some(&timeout)) {
                Ok(0) => return Err(timed_out()),
                Ok(_) => return Ok(()),
                Err(Errno::INTR) => {}
                Err(err) => return Err(err.into()),
            }
        }
    }

    fn read(&self, buf: &mut [u8], fd_storage: &mut Vec<RawFdContainer>) -> io::Result<usize> {
        self.inner.read(buf, fd_storage)
    }

    fn write(&self, buf: &[u8], fds: &mut Vec<RawFdContainer>) -> io::Result<usize> {
        self.inner.write(buf, fds)
    }

    fn write_vectored(&self, bufs: &[IoSlice<'_>], fds: &mut Vec<RawFdContainer>) -> io::Result<usize> {
        self.inner.write_vectored(bufs, fds)
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::os::unix::net::UnixStream;
    use std::thread;

    use x11rb::rust_connection::RustConnection;

    use super::*;

    fn connect_within_the_timeout(ours: UnixStream) -> Duration {
        let (stream, _) = DefaultStream::from_unix_stream(ours).unwrap();
        let start = Instant::now();
        let result = RustConnection::connect_to_stream(TimedStream::new(stream, start + LOOKUP_TIMEOUT), 0);
        assert!(result.is_err());
        start.elapsed()
    }

    #[test]
    fn a_server_that_never_answers_times_out() {
        let (ours, _silent_peer) = UnixStream::pair().unwrap();
        let elapsed = connect_within_the_timeout(ours);
        assert!(elapsed >= LOOKUP_TIMEOUT && elapsed < LOOKUP_TIMEOUT * 2, "{elapsed:?}");
    }

    #[test]
    fn a_server_that_answers_a_byte_at_a_time_times_out_at_the_same_deadline() {
        let (ours, mut peer) = UnixStream::pair().unwrap();
        // A successful setup reply of 65535 4-byte units, sent a byte every
        // 100 ms.
        let trickle = thread::spawn(move || {
            let header = [1u8, 0, 11, 0, 0, 0, 0xff, 0xff];
            for byte in header.into_iter().chain(std::iter::repeat(0)).take(60) {
                if peer.write_all(&[byte]).is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        });
        let elapsed = connect_within_the_timeout(ours);
        assert!(elapsed >= LOOKUP_TIMEOUT && elapsed < LOOKUP_TIMEOUT * 2, "{elapsed:?}");
        trickle.join().unwrap();
    }

    #[test]
    fn a_passed_deadline_fails_without_waiting() {
        let (ours, _peer) = UnixStream::pair().unwrap();
        let (stream, _) = DefaultStream::from_unix_stream(ours).unwrap();
        let stream = TimedStream::new(stream, Instant::now());
        let error = stream.poll(PollMode::Readable).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }
}
