/**
 * Occlusion + rotation — model layer.
 *
 * ROTATION: dip/footprint instances may carry rotation 0|90|180|270.
 *  - dipHoles 180 mirrors the pin walk in place (swap rows AND reverse column
 *    order; `at` keeps naming the row-f LEFT hole, pin 1 ends at the row-e
 *    RIGHT end). 90/270 are impossible for a DIP (single-column shorts).
 *  - footprintHoles rotates the pin offsets about pin 1 in clockwise quarter
 *    turns of (dCol, dRowIndex).
 *
 * OCCLUSION: bodyFootprint rects in the catalog describe the plan-rect a
 * part's molded body covers; occludedHoles() = covered holes minus the part's
 * own pins; the validator ERRORS when any other pin or wire end plugs into a
 * covered hole (the "pot overhang lets wires clip" bug).
 */
import { describe, expect, it } from 'vitest'

import {
  componentPinHoles,
  dipHoles,
  footprintHoles,
  formatHole,
  rotateOffsetDelta,
} from '../src/model/breadboard'
import { occludedHoles, occludedOffsetsForEntry, leadsBodyOverhang } from '../src/model/occlusion'
import { validateLayout } from '../src/model/validate'
import { CATALOG } from '../src/model/catalog'
import {
  isRotation,
  type ComponentInstance,
  type Rotation,
  type StripHole,
} from '../src/model/types'
import { emitToLayout, layoutToEmit } from '../src/llm/schema'
import { buildSystemPrompt } from '../src/llm/prompt'
import { leads, layout, poweredLayout, supply5, mustParse, wire, twoLead } from './helpers'

const fmt = (holes: StripHole[] | null): string[] | null =>
  holes ? holes.map((h) => formatHole(h)) : null

/** Anchored instance with a rotation. */
function rotated(id: string, type: string, at: string, rotation: Rotation): ComponentInstance {
  return rotation === 0 ? { id, type, at } : { id, type, at, rotation }
}

// ---------------------------------------------------------------- rotation

describe('isRotation', () => {
  it('accepts exactly the four quarter turns', () => {
    expect(isRotation(0)).toBe(true)
    expect(isRotation(90)).toBe(true)
    expect(isRotation(180)).toBe(true)
    expect(isRotation(270)).toBe(true)
    expect(isRotation(45)).toBe(false)
    expect(isRotation(-90)).toBe(false)
    expect(isRotation('180')).toBe(false)
    expect(isRotation(undefined)).toBe(false)
  })
})

describe('rotateOffsetDelta', () => {
  it('rotates clockwise in plan view by quarter turns', () => {
    // a rightward delta turns downward (rows increase downward in plan view)
    expect(rotateOffsetDelta(1, 0, 0)).toEqual({ dCol: 1, dRow: 0 })
    expect(rotateOffsetDelta(1, 0, 90)).toEqual({ dCol: 0, dRow: 1 })
    expect(rotateOffsetDelta(1, 0, 180)).toEqual({ dCol: -1, dRow: 0 })
    expect(rotateOffsetDelta(1, 0, 270)).toEqual({ dCol: 0, dRow: -1 })
    // four quarter turns compose to identity
    let d = { dCol: 2, dRow: -1 }
    for (let i = 0; i < 4; i++) d = rotateOffsetDelta(d.dCol, d.dRow, 90)
    expect(d).toEqual({ dCol: 2, dRow: -1 })
  })
})

describe('dipHoles rotation', () => {
  it('180 mirrors the pin walk exactly (DIP-8 at f20)', () => {
    // rotating 180 in place: swap rows AND reverse column order; the anchor
    // keeps naming the row-f left end, so pin 1 lands at the row-e RIGHT end
    expect(fmt(dipHoles(mustParse('f20'), 8, 'standard', 180))).toEqual([
      'e23', 'e22', 'e21', 'e20', // pins 1..4
      'f20', 'f21', 'f22', 'f23', // pins 5..8
    ])
  })

  it('180 occupies exactly the same holes as 0 (pin i ↔ pin i+N/2)', () => {
    const r0 = dipHoles(mustParse('f10'), 14, 'standard', 0)!
    const r180 = dipHoles(mustParse('f10'), 14, 'standard', 180)!
    expect(fmt(r180)!.slice().sort()).toEqual(fmt(r0)!.slice().sort())
    for (let i = 0; i < 7; i++) {
      expect(formatHole(r180[i])).toBe(formatHole(r0[i + 7]))
      expect(formatHole(r180[i + 7])).toBe(formatHole(r0[i]))
    }
    // pin 1 of a 180-rotated DIP-14 sits at the row-e right end
    expect(formatHole(r180[0])).toBe('e16')
  })

  it('rejects 90/270 (every pin pair would short in one strip column)', () => {
    expect(dipHoles(mustParse('f20'), 8, 'standard', 90)).toBeNull()
    expect(dipHoles(mustParse('f20'), 8, 'standard', 270)).toBeNull()
  })

  it('back-compat: omitted rotation = 0', () => {
    expect(fmt(dipHoles(mustParse('f20'), 8))).toEqual(
      fmt(dipHoles(mustParse('f20'), 8, 'standard', 0)),
    )
  })

  it('keeps the anchor-row and bounds rules at 180', () => {
    expect(dipHoles(mustParse('e20'), 8, 'standard', 180)).toBeNull() // anchor must stay row f
    expect(dipHoles(mustParse('f58'), 14, 'standard', 180)).toBeNull() // same bounds as 0
    expect(dipHoles(mustParse('f57'), 14, 'standard', 180)).not.toBeNull()
  })
})

describe('footprintHoles rotation', () => {
  const offsets = CATALOG.pushbutton.footprintOffsets!

  it('rotates the pin offsets about pin 1 in quarter turns', () => {
    // pin order: A1 (anchor), A2, B1, B2
    expect(fmt(footprintHoles(mustParse('f20'), offsets, 'standard', 0))).toEqual([
      'f20', 'e20', 'f22', 'e22',
    ])
    expect(fmt(footprintHoles(mustParse('f20'), offsets, 'standard', 90))).toEqual([
      'f20', 'f21', 'h20', 'h21',
    ])
    expect(fmt(footprintHoles(mustParse('f20'), offsets, 'standard', 180))).toEqual([
      'f20', 'g20', 'f18', 'g18',
    ])
    expect(fmt(footprintHoles(mustParse('f20'), offsets, 'standard', 270))).toEqual([
      'f20', 'f19', 'd20', 'd19',
    ])
  })

  it('returns null when rotated offsets run off the rows or columns', () => {
    // 270 sends B1 two rows UP: anchored at row b that is off the strip rows
    expect(footprintHoles(mustParse('b20'), offsets, 'standard', 270)).toBeNull()
    // 180 sends B1 two columns LEFT: anchored at col 1 that is off the board
    expect(footprintHoles(mustParse('f1'), offsets, 'standard', 180)).toBeNull()
  })

  it('keeps the designed-anchor-row rule at rotation 0 and relaxes it when rotated', () => {
    expect(footprintHoles(mustParse('e30'), offsets, 'standard', 0)).toBeNull()
    // rotated placements may anchor anywhere their rotated offsets fit
    expect(fmt(footprintHoles(mustParse('b30'), offsets, 'standard', 90))).toEqual([
      'b30', 'b31', 'd30', 'd31',
    ])
  })
})

describe('componentPinHoles rotation threading', () => {
  it('threads dip rotation (back-compat: absent = 0)', () => {
    const r0 = componentPinHoles({ id: 'U1', type: 'ne555', at: 'f20' }, CATALOG.ne555)!
    const r180 = componentPinHoles(
      { id: 'U1', type: 'ne555', at: 'f20', rotation: 180 },
      CATALOG.ne555,
    )!
    expect(formatHole(r0[0]!)).toBe('f20')
    expect(formatHole(r180[0]!)).toBe('e23')
    expect(formatHole(r180[4]!)).toBe('f20')
  })

  it('threads footprint rotation', () => {
    const holes = componentPinHoles(
      { id: 'SW1', type: 'pushbutton', at: 'f20', rotation: 90 },
      CATALOG.pushbutton,
    )!
    expect(holes.map((h) => formatHole(h!))).toEqual(['f20', 'f21', 'h20', 'h21'])
  })

  it('treats a non-quarter-turn rotation as malformed', () => {
    expect(
      componentPinHoles(
        { id: 'U1', type: 'ne555', at: 'f20', rotation: 45 as never },
        CATALOG.ne555,
      ),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------- occlusion

describe('occludedHoles', () => {
  it('pot body overhangs one column and one row around its leads', () => {
    const pot = leads('RV1', 'potentiometer', ['b10', 'b12', 'b14'])
    const occ = occludedHoles(pot, CATALOG.potentiometer)
    // covered rect: cols 9..15 × rows a..c, minus the 3 pins
    expect(occ.size).toBe(7 * 3 - 3)
    for (const ref of ['a10', 'a12', 'c12', 'b11', 'b13', 'a9', 'c15', 'b9', 'b15']) {
      expect(occ.has(ref), `${ref} should be occluded`).toBe(true)
    }
    for (const ref of ['b10', 'b12', 'b14']) {
      expect(occ.has(ref), `own pin ${ref} must not be occluded`).toBe(false)
    }
    for (const ref of ['d12', 'b8', 'b16', 'a8']) {
      expect(occ.has(ref), `${ref} is outside the body`).toBe(false)
    }
  })

  it('pot at the board edge clips the rect to real holes', () => {
    const pot = leads('RV1', 'potentiometer', ['a8', 'a9', 'a10'])
    const occ = occludedHoles(pot, CATALOG.potentiometer)
    // rows: only a..b exist (no row above a); cols 7..11
    expect([...occ].sort()).toEqual(['a11', 'a7', 'b10', 'b11', 'b7', 'b8', 'b9'])
  })

  it('pushbutton covers its middle column (rows e/f)', () => {
    const occ = occludedHoles({ id: 'SW1', type: 'pushbutton', at: 'f20' }, CATALOG.pushbutton)
    expect([...occ].sort()).toEqual(['e21', 'f21'])
  })

  it('pushbutton occlusion rotates with the pins (90 → middle row)', () => {
    const occ = occludedHoles(
      { id: 'SW1', type: 'pushbutton', at: 'f20', rotation: 90 },
      CATALOG.pushbutton,
    )
    expect([...occ].sort()).toEqual(['g20', 'g21'])
  })

  it('explicit pin-rect bodies and auto DIPs occlude nothing beyond their pins', () => {
    expect(occludedHoles({ id: 'DS1', type: 'seven_segment', at: 'f24' }, CATALOG.seven_segment).size).toBe(0)
    expect(occludedHoles({ id: 'SW1', type: 'dip_switch_8', at: 'f10' }, CATALOG.dip_switch_8).size).toBe(0)
    expect(occludedHoles({ id: 'U1', type: 'ne555', at: 'f20' }, CATALOG.ne555).size).toBe(0)
    expect(
      occludedHoles({ id: 'U1', type: 'ne555', at: 'f20', rotation: 180 }, CATALOG.ne555).size,
    ).toBe(0)
  })

  it('parts without a bodyFootprint and malformed instances occlude nothing', () => {
    expect(occludedHoles(twoLead('R1', 'resistor', 'a5', 'a9'), CATALOG.resistor).size).toBe(0)
    // malformed pot (wrong hole count): validator reports that separately
    expect(occludedHoles(leads('RV1', 'potentiometer', ['a5', 'a6']), CATALOG.potentiometer).size).toBe(0)
  })

  it('prompt helpers expose the rects', () => {
    expect(occludedOffsetsForEntry(CATALOG.pushbutton)).toEqual([
      { dCol: 1, row: 'e' },
      { dCol: 1, row: 'f' },
    ])
    expect(occludedOffsetsForEntry(CATALOG.seven_segment)).toEqual([])
    expect(occludedOffsetsForEntry(CATALOG.ne555)).toBeNull() // 'auto'
    expect(occludedOffsetsForEntry(CATALOG.potentiometer)).toBeNull() // leads
    expect(leadsBodyOverhang(CATALOG.potentiometer)).toEqual({
      left: 1,
      right: 1,
      above: 1,
      below: 1,
    })
    expect(leadsBodyOverhang(CATALOG.pushbutton)).toBeNull()
  })
})

// ---------------------------------------------------------------- validator

describe('validateLayout rotation rules', () => {
  it('rejects 90/270 on a DIP with a teaching message', () => {
    for (const type of ['ne555', 'seven_segment'] as const) {
      const res = validateLayout(poweredLayout([rotated('U1', type, 'f20', 90)], []))
      expect(res.ok).toBe(false)
      expect(res.errors.join('\n')).toContain(
        'rotating a DIP 90 would put every pin in one strip column, shorting them',
      )
    }
  })

  it('accepts 0/180 on a DIP and round-trips the rotation', () => {
    const res = validateLayout(poweredLayout([rotated('U1', 'ne555', 'f20', 180)], []))
    expect(res.errors, res.errors.join('\n')).toEqual([])
    expect(res.ok).toBe(true)
    expect(res.layout!.components.find((c) => c.id === 'U1')!.rotation).toBe(180)
  })

  it('canonicalizes explicit rotation 0 to absent', () => {
    const res = validateLayout(poweredLayout([rotated('U1', 'ne555', 'f20', 0)], []))
    expect(res.ok).toBe(true)
    expect(res.layout!.components.find((c) => c.id === 'U1')!.rotation).toBeUndefined()
  })

  it('accepts all four rotations on the pushbutton', () => {
    for (const rotation of [0, 90, 180, 270] as Rotation[]) {
      const res = validateLayout(poweredLayout([rotated('SW1', 'pushbutton', 'f20', rotation)], []))
      expect(res.errors, `rotation ${rotation}: ${res.errors.join('\n')}`).toEqual([])
    }
  })

  it('rejects a rotated footprint that runs off the rows', () => {
    const res = validateLayout(
      poweredLayout([{ id: 'SW1', type: 'pushbutton', at: 'b20', rotation: 270 }], []),
    )
    expect(res.ok).toBe(false)
    expect(res.errors.join('\n')).toContain('footprint rotated 270 does not fit')
  })

  it('rejects non-quarter-turn values', () => {
    // raw JSON input (the type system forbids 45, but imports can carry it)
    const res = validateLayout({
      version: 1,
      components: [supply5(), { id: 'U1', type: 'ne555', at: 'f20', rotation: 45 }],
      wires: [],
    })
    expect(res.ok).toBe(false)
    expect(res.errors.join('\n')).toContain('"rotation" must be 0, 90, 180 or 270')
  })

  it('rejects the field on leads, probe and off-board parts (even rotation 0)', () => {
    const cases: ComponentInstance[] = [
      { ...twoLead('R1', 'resistor', 'a5', 'a9'), rotation: 0 },
      { ...leads('P1', 'scope_probe', ['j30']), rotation: 90 },
      { ...supply5('PS2'), rotation: 180 },
    ]
    for (const comp of cases) {
      const res = validateLayout(poweredLayout([comp], []))
      expect(res.ok).toBe(false)
      expect(res.errors.join('\n')).toContain('does not take "rotation"')
    }
  })

  it('a 180-rotated DIP wires by the rotated pin map', () => {
    // VCC (pin 8 of the ne555) sits at f23 when rotated 180 — claiming that
    // hole with a wire must collide with the rotated pin, not pin 4 (RESET)
    const res = validateLayout(
      poweredLayout([rotated('U1', 'ne555', 'f20', 180)], [wire('f23', 'top+1')]),
    )
    expect(res.ok).toBe(false)
    expect(res.errors.join('\n')).toContain('pin VCC of "U1"')
  })
})

describe('validateLayout occlusion rules', () => {
  it("errors when another part's pin lands under the pot body", () => {
    const res = validateLayout(
      poweredLayout(
        [
          leads('RV1', 'potentiometer', ['b10', 'b12', 'b14']),
          twoLead('R9', 'resistor', 'c12', 'c20'),
        ],
        [],
      ),
    )
    expect(res.ok).toBe(false)
    const msg = res.errors.join('\n')
    expect(msg).toContain('"c12"')
    expect(msg).toContain("is covered by RV1's body — pick a hole clear of the overhang")
  })

  it('errors when a wire end lands under a body (pot + pushbutton)', () => {
    const potRes = validateLayout(
      poweredLayout([leads('RV1', 'potentiometer', ['b10', 'b12', 'b14'])], [wire('a12', 'top+1')]),
    )
    expect(potRes.ok).toBe(false)
    expect(potRes.errors.join('\n')).toMatch(
      /hole "a12" \(the "from" end of wire "w\d+"\) is covered by RV1's body/,
    )

    const btnRes = validateLayout(
      poweredLayout([{ id: 'SW1', type: 'pushbutton', at: 'f20' }], [wire('e21', 'top+1')]),
    )
    expect(btnRes.ok).toBe(false)
    expect(btnRes.errors.join('\n')).toContain("is covered by SW1's body")
  })

  it('clean placements stay clean (back-compat)', () => {
    // classic button-LED wiring touches no occluded hole
    const res = validateLayout(
      poweredLayout(
        [
          { id: 'SW1', type: 'pushbutton', at: 'f10' },
          twoLead('R1', 'resistor', 'j12', 'j16'),
          leads('RV1', 'potentiometer', ['j20', 'j22', 'j24']),
        ],
        [wire('h20', 'top+1')], // h-row hole BELOW the pot row is clear (body spans i..j+1→clipped)
      ),
    )
    expect(res.errors, res.errors.join('\n')).toEqual([])
    expect(res.ok).toBe(true)
  })
})

// ------------------------------------------------------------ LLM plumbing

describe('LLM rotation/occlusion plumbing', () => {
  it('emitToLayout keeps quarter-turn rotations and drops 0/null/junk', () => {
    const base = {
      id: 'U1',
      type: 'ne555',
      at: 'f20',
      holes: [] as string[],
      params: [] as { key: string; value: number }[],
    }
    const mk = (rotation: number | null) =>
      emitToLayout({
        name: '',
        board: null,
        boardCount: null,
        boardRows: null,
        components: [{ ...base, rotation }],
        wires: [],
      }).components[0].rotation
    expect(mk(180)).toBe(180)
    expect(mk(90)).toBe(90)
    expect(mk(0)).toBeUndefined()
    expect(mk(null)).toBeUndefined()
    expect(mk(45)).toBeUndefined()
  })

  it('layoutToEmit round-trips rotation (absent → null)', () => {
    const l = layout([rotated('U1', 'ne555', 'f20', 180), rotated('U2', 'ne555', 'f30', 0)], [])
    const emitted = layoutToEmit(l)
    expect(emitted.components[0].rotation).toBe(180)
    expect(emitted.components[1].rotation).toBeNull()
  })

  it('the system prompt documents rotation and per-part occlusion', () => {
    const p = buildSystemPrompt()
    expect(p).toContain('rotating a DIP 90 would put every pin in one strip column')
    expect(p).toContain('BODY OVERHANG')
    expect(p).toContain('body occlusion')
    // the pushbutton warning names its covered middle-column cells
    expect(p).toContain('(col+1, row e), (col+1, row f)')
    // the pot warning describes its overhang
    expect(p).toMatch(/overhangs 1 column\(s\) beyond each outer lead/)
  })
})
