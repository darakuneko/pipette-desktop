// SPDX-License-Identifier: GPL-2.0-or-later
//! x11rb's socket with a time limit on each wait. x11rb's own stream waits
//! for the server without end (so does Xlib); a server that stops answering
//! would otherwise hold the analytics flush.

use std::io::{self, IoSlice};
use std::time::Duration;

use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::fd::AsFd;
use rustix::io::Errno;
use x11rb::rust_connection::{DefaultStream, PollMode, Stream};
use x11rb::utils::RawFdContainer;

/// How long one wait to read or write may last.
pub(crate) const IO_TIMEOUT: Duration = Duration::from_secs(2);

/// A [`DefaultStream`] whose waits fail with `TimedOut` after
/// [`IO_TIMEOUT`]; reads and writes are its own.
pub(crate) struct TimedStream(pub DefaultStream);

impl Stream for TimedStream {
    fn poll(&self, mode: PollMode) -> io::Result<()> {
        let mut flags = PollFlags::empty();
        if mode.readable() {
            flags |= PollFlags::IN;
        }
        if mode.writable() {
            flags |= PollFlags::OUT;
        }
        let timeout = Timespec { tv_sec: IO_TIMEOUT.as_secs() as _, tv_nsec: 0 };
        let mut fds = [PollFd::from_borrowed_fd(self.0.as_fd(), flags)];
        loop {
            match poll(&mut fds, Some(&timeout)) {
                Ok(0) => {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "the X server did not answer in time",
                    ));
                }
                Ok(_) => return Ok(()),
                Err(Errno::INTR) => {}
                Err(err) => return Err(err.into()),
            }
        }
    }

    fn read(&self, buf: &mut [u8], fd_storage: &mut Vec<RawFdContainer>) -> io::Result<usize> {
        self.0.read(buf, fd_storage)
    }

    fn write(&self, buf: &[u8], fds: &mut Vec<RawFdContainer>) -> io::Result<usize> {
        self.0.write(buf, fds)
    }

    fn write_vectored(&self, bufs: &[IoSlice<'_>], fds: &mut Vec<RawFdContainer>) -> io::Result<usize> {
        self.0.write_vectored(bufs, fds)
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::net::UnixStream;
    use std::time::Instant;

    use x11rb::rust_connection::RustConnection;

    use super::*;

    #[test]
    fn a_server_that_never_answers_times_out() {
        let (ours, _silent_peer) = UnixStream::pair().unwrap();
        let (stream, _) = DefaultStream::from_unix_stream(ours).unwrap();
        let start = Instant::now();
        let result = RustConnection::connect_to_stream(TimedStream(stream), 0);
        let elapsed = start.elapsed();
        assert!(result.is_err());
        assert!(elapsed >= IO_TIMEOUT && elapsed < IO_TIMEOUT * 3, "{elapsed:?}");
    }
}
