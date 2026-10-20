import { describe, it, expect } from 'vitest'
import { buildCsp, securityHeaders } from '../csp'

describe('buildCsp', () => {
  describe('base directives (shared)', () => {
    const csp = buildCsp(false)

    it('includes default-src self', () => {
      expect(csp).toContain("default-src 'self'")
    })

    it('includes object-src none', () => {
      expect(csp).toContain("object-src 'none'")
    })

    it('includes base-uri self', () => {
      expect(csp).toContain("base-uri 'self'")
    })

    it('includes frame-ancestors none', () => {
      expect(csp).toContain("frame-ancestors 'none'")
    })

    it('includes form-action self', () => {
      expect(csp).toContain("form-action 'self'")
    })

    it('includes frame-src none', () => {
      expect(csp).toContain("frame-src 'none'")
    })

    it('has no duplicate directive keys', () => {
      const keys = csp.split('; ').map((d) => d.split(/\s/)[0])
      const unique = new Set(keys)
      expect(keys.length).toBe(unique.size)
    })
  })

  describe('production', () => {
    const csp = buildCsp(false)

    it('does not include unsafe-inline', () => {
      expect(csp).not.toContain('unsafe-inline')
    })

    it('does not include unsafe-eval', () => {
      expect(csp).not.toContain('unsafe-eval')
    })

    it('does not include ws:// connect-src', () => {
      expect(csp).not.toContain('ws://')
    })
  })

  describe('development', () => {
    const csp = buildCsp(true)

    it('allows unsafe-inline for script-src', () => {
      expect(csp).toMatch(/script-src\s+'self'\s+'unsafe-inline'/)
    })

    it('allows unsafe-inline for style-src', () => {
      expect(csp).toMatch(/style-src\s+'self'\s+'unsafe-inline'/)
    })

    it('allows ws://localhost for connect-src', () => {
      expect(csp).toContain('ws://localhost:*')
    })

    it('has no duplicate directive keys', () => {
      const keys = csp.split('; ').map((d) => d.split(/\s/)[0])
      const unique = new Set(keys)
      expect(keys.length).toBe(unique.size)
    })
  })
})

describe('securityHeaders', () => {
  it('includes X-Content-Type-Options nosniff', () => {
    expect(securityHeaders).toHaveProperty('X-Content-Type-Options', ['nosniff'])
  })

  it('includes X-Frame-Options DENY', () => {
    expect(securityHeaders).toHaveProperty('X-Frame-Options', ['DENY'])
  })
})
