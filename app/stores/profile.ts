import { defineStore } from 'pinia'
import { get, set } from 'idb-keyval'
import type { Lang } from '~~/content/types'
import { buddyLabel, type BuddyName } from '~/utils/buddies'

const KEY = 'bibo.profiles.v2'
/**
 * The Phase 0 shape: one anonymous profile, no id. Read once on first load and
 * migrated forward. Deliberately NOT deleted afterwards - it is a few hundred
 * bytes, and it is the only copy of a child's progress if the v2 write fails on
 * a device with blocked storage.
 */
const LEGACY_KEY = 'bibo.profile.v1'

/** A family, not a classroom. Keeps local storage and the picker bounded. */
export const MAX_PROFILES = 6

export type Band = 'usbong' | 'puno'

/**
 * Leitner state for one concept in ONE language, keyed `conceptId:lang`. A
 * child who learns `dog` in Cebuano still meets it fresh in Ilocano.
 *
 * The counters mirror the `progress` table in server/db/schema.ts so that sync
 * is a field copy rather than a reconstruction. `dueAt` is deliberately absent
 * until scheduling is implemented - an unwritten column is easier to add later
 * than a wrong one is to correct.
 */
export interface ProgressRecord {
  /** 1..5 */
  box: number
  seen: number
  lapses: number
  /** ISO timestamp of the last answer, or null if migrated from v1. */
  lastAt: string | null
}

/**
 * One child. Local-first: this exists on the device and needs no account. The
 * `id` is the whole point of the v2 shape - a profile cannot be linked to a
 * parent account, or synced across a phone and a tablet, until it has a stable
 * name to be linked BY. Spec section 11.
 */
export interface ChildProfile {
  id: string
  /** Free text, chosen by an adult. Empty until someone sets it. */
  name: string
  buddy: BuddyName | null
  lang: Lang | null
  band: Band
  xp: number
  progress: Record<string, ProgressRecord>
  createdAt: string
}

interface ProfileState {
  ready: boolean
  activeId: string | null
  profiles: ChildProfile[]
}

/** The v1 record, for migration only. */
interface LegacyProfile {
  buddy: BuddyName | null
  lang: Lang | null
  band: Band
  xp: number
  boxes: Record<string, number>
}

/**
 * `crypto.randomUUID` is unavailable outside a secure context, and testing this
 * app on a family tablet over `http://192.168.x.x` is exactly that case. Fall
 * back rather than throw: an id only has to be unique within one device.
 */
function newId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function blankProfile(name = ''): ChildProfile {
  return {
    id: newId(),
    name,
    buddy: null,
    lang: null,
    band: 'usbong',
    xp: 0,
    progress: {},
    createdAt: new Date().toISOString(),
  }
}

/** What to call a profile in a list before anyone has named it. */
export function profileLabel(p: ChildProfile): string {
  if (p.name.trim()) return p.name.trim()
  if (p.buddy) return buddyLabel(p.buddy)
  return 'Bagong bata'
}

function fromLegacy(old: Partial<LegacyProfile>): ChildProfile {
  const p = blankProfile()
  p.buddy = old.buddy ?? null
  p.lang = old.lang ?? null
  p.band = old.band ?? 'usbong'
  p.xp = old.xp ?? 0

  // v1 stored only the box number. `seen` and `lapses` start at zero because
  // they were never recorded - honest, and the counters feed future scheduling
  // rather than anything already shown to a child.
  for (const [k, box] of Object.entries(old.boxes ?? {})) {
    p.progress[k] = { box, seen: 0, lapses: 0, lastAt: null }
  }

  return p
}

/**
 * Local-first. Profiles live on the device and need no account: a child never
 * logs in, and nothing here reaches a server unless a parent creates one and
 * links a profile explicitly. Spec section 11.
 *
 * Everything a page touches - `buddy`, `lang`, `xp`, `boxes`, `record()` - acts
 * on the ACTIVE profile, so the child app stays unaware that there can be more
 * than one.
 */
export const useProfile = defineStore('profile', {
  state: (): ProfileState => ({
    ready: false,
    activeId: null,
    profiles: [],
  }),

  getters: {
    active(s): ChildProfile | null {
      return s.profiles.find((p) => p.id === s.activeId) ?? null
    },

    started(): boolean {
      return Boolean(this.active?.buddy && this.active?.lang)
    },

    buddy(): BuddyName | null {
      return this.active?.buddy ?? null
    },

    lang(): Lang | null {
      return this.active?.lang ?? null
    },

    band(): Band {
      return this.active?.band ?? 'usbong'
    },

    xp(): number {
      return this.active?.xp ?? 0
    },

    /**
     * `conceptId:lang -> box`, the shape the lesson screens read. Derived, so
     * the richer record stays the single source of truth.
     */
    boxes(): Record<string, number> {
      const out: Record<string, number> = {}
      const p = this.active
      if (!p) return out
      for (const [k, r] of Object.entries(p.progress)) out[k] = r.box
      return out
    },

    canAddProfile(s): boolean {
      return s.profiles.length < MAX_PROFILES
    },
  },

  actions: {
    async load() {
      if (this.ready) return

      const saved = await get<Pick<ProfileState, 'activeId' | 'profiles'>>(KEY).catch(() => null)
      if (saved?.profiles?.length) {
        this.profiles = saved.profiles
        this.activeId = saved.activeId ?? saved.profiles[0]!.id
        this.ready = true
        return
      }

      const legacy = await get<Partial<LegacyProfile>>(LEGACY_KEY).catch(() => null)
      const first = legacy ? fromLegacy(legacy) : blankProfile()

      this.profiles = [first]
      this.activeId = first.id
      this.ready = true

      // Write immediately, so a migrated child is not re-migrated every load.
      await this.persist()
    },

    async persist() {
      const { ready: _ready, ...rest } = this.$state
      try {
        // Pinia state is a Vue reactive Proxy, and IndexedDB clones structurally
        // - a Proxy is not structured-cloneable, so writing `rest` directly
        // throws DataCloneError and nothing is ever saved. Snapshot to plain
        // JSON first. The state is deliberately JSON-safe for this reason.
        await set(KEY, JSON.parse(JSON.stringify(rest)))
      } catch (err) {
        // Private mode or blocked storage is survivable: the session keeps
        // working, it just will not outlive a reload. Never throw at a child -
        // but never swallow it silently in development either.
        if (import.meta.dev) console.warn('[profile] persist failed', err)
      }
    },

    async pickBuddy(buddy: BuddyName) {
      if (!this.active) return
      this.active.buddy = buddy
      await this.persist()
    },

    async pickLang(lang: Lang) {
      if (!this.active) return
      this.active.lang = lang
      await this.persist()
    },

    async pickBand(band: Band) {
      if (!this.active) return
      this.active.band = band
      await this.persist()
    },

    async award(xp: number) {
      if (!this.active) return
      this.active.xp += xp
      await this.persist()
    },

    /** Leitner promote / demote. Intervals are halved in Usbong - section 06. */
    async record(conceptId: string, lang: Lang, correct: boolean) {
      const p = this.active
      if (!p) return

      const k = `${conceptId}:${lang}`
      const prev = p.progress[k] ?? { box: 1, seen: 0, lapses: 0, lastAt: null }

      p.progress[k] = {
        box: correct ? Math.min(5, prev.box + 1) : Math.max(1, prev.box - 1),
        seen: prev.seen + 1,
        lapses: correct ? prev.lapses : prev.lapses + 1,
        lastAt: new Date().toISOString(),
      }

      await this.persist()
    },

    /** Create a child. Returns null at the cap rather than throwing. */
    async createProfile(name = ''): Promise<ChildProfile | null> {
      if (!this.canAddProfile) return null

      const p = blankProfile(name)
      this.profiles.push(p)
      await this.persist()
      return p
    },

    async switchProfile(id: string) {
      if (!this.profiles.some((p) => p.id === id)) return
      this.activeId = id
      await this.persist()
    },

    async renameProfile(id: string, name: string) {
      const p = this.profiles.find((x) => x.id === id)
      if (!p) return
      p.name = name.trim().slice(0, 40)
      await this.persist()
    },

    /**
     * Delete a child and everything learned under it. The device is never left
     * without a profile: removing the last one leaves a fresh empty one, so the
     * child app still opens straight into play.
     */
    async removeProfile(id: string) {
      this.profiles = this.profiles.filter((p) => p.id !== id)

      if (!this.profiles.length) {
        const fresh = blankProfile()
        this.profiles = [fresh]
        this.activeId = fresh.id
      } else if (this.activeId === id) {
        this.activeId = this.profiles[0]!.id
      }

      await this.persist()
    },

    /** Clear the active profile back to first-run, keeping its id. */
    async reset() {
      const p = this.active
      if (!p) return

      p.buddy = null
      p.lang = null
      p.xp = 0
      p.progress = {}
      await this.persist()
    },
  },
})
