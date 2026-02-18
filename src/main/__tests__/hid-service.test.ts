// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  MSG_LEN,
  HID_USAGE_PAGE,
  HID_USAGE,
  HID_REPORT_ID,
  HID_RETRY_COUNT,
  HID_RETRY_DELAY_MS,
  HID_OPEN_RETRY_COUNT,
  HID_OPEN_RETRY_DELAY_MS,
  VIAL_SERIAL_MAGIC,
  BOOTLOADER_SERIAL_MAGIC,
} from '../../shared/constants/protocol'

// --- Mock node-hid ---

const mockWrite = vi.fn()
const mockRead = vi.fn()
const mockClose = vi.fn()

const mockHIDAsyncOpen = vi.fn()
const mockDevicesAsync = vi.fn()

vi.mock('node-hid', () => ({
  default: {
    devicesAsync: (...args: unknown[]) => mockDevicesAsync(...args),
    HIDAsync: {
      open: (...args: unknown[]) => mockHIDAsyncOpen(...args),
    },
  },
}))

// --- Mock logger ---

vi.mock('../../main/logger', () => ({
  log: vi.fn(),
  logHidPacket: vi.fn(),
}))

// --- Import after mocking ---

import {
  listDevices,
  openHidDevice,
  closeHidDevice,
  sendReceive,
  send,
  isDeviceOpen,
  validateHidData,
} from '../hid-service'

function createMockDeviceInfo(overrides?: Record<string, unknown>) {
  return {
    vendorId: 0x1234,
    productId: 0x5678,
    path: '/dev/hidraw0',
    serialNumber: VIAL_SERIAL_MAGIC,
    product: 'Test Keyboard',
    usagePage: HID_USAGE_PAGE,
    usage: HID_USAGE,
    ...overrides,
  }
}

function createMockOpenDevice() {
  return {
    write: mockWrite,
    read: mockRead,
    close: mockClose,
  }
}

// --- Test suites ---

beforeEach(async () => {
  vi.clearAllMocks()
  mockWrite.mockReturnValue(MSG_LEN + 1)
  await closeHidDevice()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('listDevices', () => {
  it('returns devices with matching usagePage+usage', async () => {
    mockDevicesAsync.mockResolvedValue([createMockDeviceInfo()])

    const result = await listDevices()

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      vendorId: 0x1234,
      productId: 0x5678,
      productName: 'Test Keyboard',
      serialNumber: VIAL_SERIAL_MAGIC,
      type: 'vial',
    })
  })

  it('classifies bootloader devices correctly', async () => {
    mockDevicesAsync.mockResolvedValue([
      createMockDeviceInfo({ serialNumber: BOOTLOADER_SERIAL_MAGIC }),
    ])

    const result = await listDevices()

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('bootloader')
  })

  it('filters out devices with wrong usage page', async () => {
    mockDevicesAsync.mockResolvedValue([
      createMockDeviceInfo({ usagePage: 0x0001, usage: 0x06 }),
    ])

    const result = await listDevices()

    expect(result).toHaveLength(0)
  })

  it('returns empty array when no devices exist', async () => {
    mockDevicesAsync.mockResolvedValue([])

    const result = await listDevices()

    expect(result).toEqual([])
  })

  it('defaults to vial type when serial is empty', async () => {
    mockDevicesAsync.mockResolvedValue([
      createMockDeviceInfo({ serialNumber: '' }),
    ])

    const result = await listDevices()

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('vial')
  })

  it('returns multiple matching devices', async () => {
    mockDevicesAsync.mockResolvedValue([
      createMockDeviceInfo({ vendorId: 0x1111 }),
      createMockDeviceInfo({
        vendorId: 0x2222,
        serialNumber: BOOTLOADER_SERIAL_MAGIC,
      }),
    ])

    const result = await listDevices()

    expect(result).toHaveLength(2)
    expect(result[0].type).toBe('vial')
    expect(result[1].type).toBe('bootloader')
  })
})

describe('openHidDevice / closeHidDevice', () => {
  it('opens a matching device by vendorId and productId', async () => {
    mockDevicesAsync.mockResolvedValue([createMockDeviceInfo()])
    mockHIDAsyncOpen.mockResolvedValue(createMockOpenDevice())

    const result = await openHidDevice(0x1234, 0x5678)

    expect(result).toBe(true)
    expect(mockHIDAsyncOpen).toHaveBeenCalledWith('/dev/hidraw0')
    await expect(isDeviceOpen()).resolves.toBe(true)
  })

  it('returns false when no matching device is found', async () => {
    mockDevicesAsync.mockResolvedValue([
      createMockDeviceInfo({ vendorId: 0x9999 }),
    ])

    const result = await openHidDevice(0x1234, 0x5678)

    expect(result).toBe(false)
    await expect(isDeviceOpen()).resolves.toBe(false)
  })

  it('returns false when device has no path', async () => {
    mockDevicesAsync.mockResolvedValue([
      createMockDeviceInfo({ path: undefined }),
    ])

    const result = await openHidDevice(0x1234, 0x5678)

    expect(result).toBe(false)
  })

  it('closes existing device before opening a new one', async () => {
    // First open
    mockDevicesAsync.mockResolvedValue([createMockDeviceInfo()])
    mockHIDAsyncOpen.mockResolvedValue(createMockOpenDevice())
    await openHidDevice(0x1234, 0x5678)

    // Second open
    mockDevicesAsync.mockResolvedValue([
      createMockDeviceInfo({ vendorId: 0xaaaa, productId: 0xbbbb, path: '/dev/hidraw1' }),
    ])
    mockHIDAsyncOpen.mockResolvedValue(createMockOpenDevice())
    await openHidDevice(0xaaaa, 0xbbbb)

    expect(mockClose).toHaveBeenCalled()
  })

  it('openHidDevice retries on failure', async () => {
    vi.useFakeTimers()
    mockDevicesAsync.mockResolvedValue([createMockDeviceInfo()])
    mockHIDAsyncOpen
      .mockRejectedValueOnce(new Error('cannot open device'))
      .mockRejectedValueOnce(new Error('cannot open device'))
      .mockResolvedValueOnce(createMockOpenDevice())

    const promise = openHidDevice(0x1234, 0x5678)
    await vi.advanceTimersByTimeAsync(HID_OPEN_RETRY_DELAY_MS)
    await vi.advanceTimersByTimeAsync(HID_OPEN_RETRY_DELAY_MS)
    const result = await promise

    expect(result).toBe(true)
    expect(mockHIDAsyncOpen).toHaveBeenCalledTimes(3)
  })

  it('openHidDevice throws after exhausting retries', async () => {
    vi.useFakeTimers()
    mockDevicesAsync.mockResolvedValue([createMockDeviceInfo()])
    mockHIDAsyncOpen.mockImplementation(() => { throw new Error('cannot open device') })

    const promise = openHidDevice(0x1234, 0x5678)
    const assertion = expect(promise).rejects.toThrow('cannot open device')
    await vi.runAllTimersAsync()

    await assertion
    expect(mockHIDAsyncOpen).toHaveBeenCalledTimes(HID_OPEN_RETRY_COUNT)
  })

  it('closeHidDevice resets state', async () => {
    mockDevicesAsync.mockResolvedValue([createMockDeviceInfo()])
    mockHIDAsyncOpen.mockResolvedValue(createMockOpenDevice())
    await openHidDevice(0x1234, 0x5678)

    await expect(isDeviceOpen()).resolves.toBe(true)

    await closeHidDevice()

    await expect(isDeviceOpen()).resolves.toBe(false)
    expect(mockClose).toHaveBeenCalled()
  })
})

describe('sendReceive', () => {
  beforeEach(async () => {
    mockDevicesAsync.mockResolvedValue([createMockDeviceInfo()])
    mockHIDAsyncOpen.mockResolvedValue(createMockOpenDevice())
    await openHidDevice(0x1234, 0x5678)
  })

  it('sends padded packet and receives response', async () => {
    const responseBuffer = Buffer.alloc(MSG_LEN)
    responseBuffer[0] = 0x42
    mockRead.mockResolvedValue(responseBuffer)

    const input = [0x01, 0x02, 0x03]
    const result = await sendReceive(input)

    // write is called with [reportId, ...paddedData]
    expect(mockWrite).toHaveBeenCalledTimes(1)
    const writeArg = mockWrite.mock.calls[0][0] as number[]
    expect(writeArg[0]).toBe(HID_REPORT_ID)
    expect(writeArg.length).toBe(MSG_LEN + 1)
    expect(writeArg[1]).toBe(0x01)
    expect(writeArg[2]).toBe(0x02)
    expect(writeArg[3]).toBe(0x03)
    expect(writeArg[4]).toBe(0x00) // padded

    expect(result[0]).toBe(0x42)
    expect(result.length).toBe(MSG_LEN)
  })

  it('strips report ID from response when present', async () => {
    // Buffer with report ID prepended: [0x00, 0x42, 0x00, ...]
    const responseBuffer = Buffer.alloc(MSG_LEN + 1)
    responseBuffer[0] = HID_REPORT_ID
    responseBuffer[1] = 0x42
    mockRead.mockResolvedValue(responseBuffer)

    const result = await sendReceive([0x01])

    // Report ID should be stripped, first data byte should be 0x42
    expect(result[0]).toBe(0x42)
    expect(result.length).toBe(MSG_LEN)
  })

  it('throws when no device is open', async () => {
    await closeHidDevice()

    await expect(sendReceive([0x01])).rejects.toThrow('No HID device is open')
  })

  it('retries on timeout', async () => {
    vi.useFakeTimers()
    mockRead
      .mockRejectedValueOnce(new Error('HID read timeout'))
      .mockRejectedValueOnce(new Error('HID read timeout'))
      .mockResolvedValueOnce(Buffer.alloc(MSG_LEN))

    const promise = sendReceive([0x01])
    await vi.advanceTimersByTimeAsync(HID_RETRY_DELAY_MS)
    await vi.advanceTimersByTimeAsync(HID_RETRY_DELAY_MS)
    const result = await promise

    expect(mockWrite).toHaveBeenCalledTimes(3)
    expect(result.length).toBe(MSG_LEN)
  })

  it('retries on transient device errors', async () => {
    vi.useFakeTimers()
    mockRead
      .mockRejectedValueOnce(new Error('could not read data from device'))
      .mockRejectedValueOnce(new Error('could not read data from device'))
      .mockResolvedValueOnce(Buffer.alloc(MSG_LEN))

    const promise = sendReceive([0x01])
    await vi.advanceTimersByTimeAsync(HID_RETRY_DELAY_MS)
    await vi.advanceTimersByTimeAsync(HID_RETRY_DELAY_MS)
    const result = await promise

    expect(mockWrite).toHaveBeenCalledTimes(3)
    expect(result.length).toBe(MSG_LEN)
  })

  it('retries on write errors', async () => {
    vi.useFakeTimers()
    mockWrite
      .mockImplementationOnce(() => { throw new Error('Cannot write to hid device') })
      .mockReturnValue(MSG_LEN + 1)
    mockRead.mockResolvedValue(Buffer.alloc(MSG_LEN))

    const promise = sendReceive([0x01])
    await vi.advanceTimersByTimeAsync(HID_RETRY_DELAY_MS)
    const result = await promise

    expect(mockWrite).toHaveBeenCalledTimes(2)
    expect(result.length).toBe(MSG_LEN)
  })

  it('throws immediately on non-transient errors', async () => {
    mockRead.mockRejectedValue(new Error('Device disconnected'))

    await expect(sendReceive([0x01])).rejects.toThrow('Device disconnected')

    expect(mockWrite).toHaveBeenCalledTimes(1)
  })

  it('adds delay between retries', async () => {
    vi.useFakeTimers()
    mockRead
      .mockRejectedValueOnce(new Error('HID read timeout'))
      .mockResolvedValueOnce(Buffer.alloc(MSG_LEN))

    const promise = sendReceive([0x01])

    // Flush microtasks so .then() callback starts — first write+read happens, read rejects, delay starts
    await vi.advanceTimersByTimeAsync(0)

    // First write happened, second hasn't because delay hasn't elapsed
    expect(mockWrite).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(HID_RETRY_DELAY_MS)
    await promise

    expect(mockWrite).toHaveBeenCalledTimes(2)
  })

  it('throws after exhausting retries', async () => {
    vi.useFakeTimers()
    mockRead.mockImplementation(() => { throw new Error('HID read timeout') })

    const promise = sendReceive([0x01])
    const assertion = expect(promise).rejects.toThrow('timeout')
    await vi.runAllTimersAsync()

    await assertion
    expect(mockWrite).toHaveBeenCalledTimes(HID_RETRY_COUNT)
  })

  it('pads input data to MSG_LEN bytes', async () => {
    mockRead.mockResolvedValue(Buffer.alloc(MSG_LEN))

    await sendReceive([0xff])

    const writeArg = mockWrite.mock.calls[0][0] as number[]
    // reportId + MSG_LEN data bytes
    expect(writeArg.length).toBe(MSG_LEN + 1)
    expect(writeArg[1]).toBe(0xff)
    for (let i = 2; i <= MSG_LEN; i++) {
      expect(writeArg[i]).toBe(0x00)
    }
  })

  it('truncates input data longer than MSG_LEN', async () => {
    mockRead.mockResolvedValue(Buffer.alloc(MSG_LEN))

    const longData = new Array(64).fill(0xab)
    await sendReceive(longData)

    const writeArg = mockWrite.mock.calls[0][0] as number[]
    expect(writeArg.length).toBe(MSG_LEN + 1)
    for (let i = 1; i <= MSG_LEN; i++) {
      expect(writeArg[i]).toBe(0xab)
    }
  })

  it('serializes concurrent sendReceive calls via mutex', async () => {
    let readCallCount = 0
    let firstResolve: ((buf: Buffer) => void) | null = null

    mockRead.mockImplementation(() => {
      readCallCount++
      if (readCallCount === 1) {
        // First read: delay response
        return new Promise<Buffer>((resolve) => {
          firstResolve = resolve
        })
      }
      // Second read: immediate
      return Promise.resolve(Buffer.alloc(MSG_LEN))
    })

    const promise1 = sendReceive([0x01])
    const promise2 = sendReceive([0x02])

    // Yield to allow first write+read
    await new Promise((r) => setTimeout(r, 10))

    // First write happened, but second must NOT have happened yet (blocked by mutex)
    expect(mockWrite).toHaveBeenCalledTimes(1)

    // Resolve first response
    firstResolve!(Buffer.alloc(MSG_LEN))
    await promise1

    // After first completes, second should proceed
    await promise2

    expect(mockWrite).toHaveBeenCalledTimes(2)
  })
})

describe('send', () => {
  it('sends padded report via write', async () => {
    mockDevicesAsync.mockResolvedValue([createMockDeviceInfo()])
    mockHIDAsyncOpen.mockResolvedValue(createMockOpenDevice())
    await openHidDevice(0x1234, 0x5678)

    await send([0x07, 0x08])

    expect(mockWrite).toHaveBeenCalledTimes(1)
    const writeArg = mockWrite.mock.calls[0][0] as number[]
    expect(writeArg[0]).toBe(HID_REPORT_ID)
    expect(writeArg[1]).toBe(0x07)
    expect(writeArg[2]).toBe(0x08)
    expect(writeArg[3]).toBe(0x00) // padded
    expect(writeArg.length).toBe(MSG_LEN + 1)
  })

  it('throws when no device is open', async () => {
    await expect(send([0x01])).rejects.toThrow('No HID device is open')
  })

  it('serializes with sendReceive via shared mutex', async () => {
    mockDevicesAsync.mockResolvedValue([createMockDeviceInfo()])
    mockHIDAsyncOpen.mockResolvedValue(createMockOpenDevice())
    await openHidDevice(0x1234, 0x5678)

    let readResolve: ((buf: Buffer) => void) | null = null
    mockRead.mockImplementation(
      () =>
        new Promise<Buffer>((resolve) => {
          readResolve = resolve
        }),
    )

    // Start sendReceive (acquires mutex, waits on read)
    const srPromise = sendReceive([0x01])
    await new Promise((r) => setTimeout(r, 10))

    // Start send (should be blocked by mutex)
    const sendPromise = send([0x02])
    await new Promise((r) => setTimeout(r, 10))

    // Only sendReceive's write should have happened
    expect(mockWrite).toHaveBeenCalledTimes(1)

    // Complete sendReceive
    readResolve!(Buffer.alloc(MSG_LEN))
    await srPromise

    // Now send should proceed
    await sendPromise
    expect(mockWrite).toHaveBeenCalledTimes(2)
  })
})

describe('validateHidData', () => {
  it('accepts valid byte array', () => {
    const result = validateHidData([0x01, 0x02, 0xff], MSG_LEN)
    expect(result).toEqual([0x01, 0x02, 0xff])
  })

  it('rejects non-array', () => {
    expect(() => validateHidData('not an array', MSG_LEN)).toThrow('must be an array')
  })

  it('rejects array exceeding max length', () => {
    const data = new Array(MSG_LEN + 1).fill(0)
    expect(() => validateHidData(data, MSG_LEN)).toThrow('exceeds maximum length')
  })

  it('rejects non-integer values', () => {
    expect(() => validateHidData([1.5], MSG_LEN)).toThrow('invalid')
  })

  it('rejects negative values', () => {
    expect(() => validateHidData([-1], MSG_LEN)).toThrow('invalid')
  })

  it('rejects values above 255', () => {
    expect(() => validateHidData([256], MSG_LEN)).toThrow('invalid')
  })

  it('rejects non-number values', () => {
    expect(() => validateHidData(['a'], MSG_LEN)).toThrow('invalid')
  })

  it('accepts empty array', () => {
    expect(validateHidData([], MSG_LEN)).toEqual([])
  })
})

describe('isDeviceOpen', () => {
  it('returns false when no device is set', async () => {
    await expect(isDeviceOpen()).resolves.toBe(false)
  })

  it('returns true when device is open', async () => {
    mockDevicesAsync.mockResolvedValue([createMockDeviceInfo()])
    mockHIDAsyncOpen.mockResolvedValue(createMockOpenDevice())
    await openHidDevice(0x1234, 0x5678)

    await expect(isDeviceOpen()).resolves.toBe(true)
  })

  it('returns false after close', async () => {
    mockDevicesAsync.mockResolvedValue([createMockDeviceInfo()])
    mockHIDAsyncOpen.mockResolvedValue(createMockOpenDevice())
    await openHidDevice(0x1234, 0x5678)

    await closeHidDevice()

    await expect(isDeviceOpen()).resolves.toBe(false)
  })

  it('returns false when device path disappears from USB enumeration', async () => {
    mockDevicesAsync.mockResolvedValue([createMockDeviceInfo()])
    mockHIDAsyncOpen.mockResolvedValue(createMockOpenDevice())
    await openHidDevice(0x1234, 0x5678)

    await expect(isDeviceOpen()).resolves.toBe(true)

    // Simulate physical disconnect: device no longer appears in enumeration
    mockDevicesAsync.mockResolvedValue([])

    await expect(isDeviceOpen()).resolves.toBe(false)
  })
})
