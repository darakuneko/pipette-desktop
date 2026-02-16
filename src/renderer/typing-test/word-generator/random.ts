// SPDX-License-Identifier: GPL-3.0-or-later
// Based on Monkeytype (https://github.com/monkeytypegame/monkeytype)

export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}
