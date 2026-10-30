"use strict";
// Client-side copies of the shared maths, used by the animated mine (the server pays the real numbers).
const { unitValue, infraScale, minersFor, upgradeCost } = Shared;
// price of the next floor: { cash, mine, shards } (floors 11+ also cost $AFKMINE, 21+ also Mine Shards)
const nextFloorCost = (mine) => Shared.shaftUnlockCost(mine.unlockedShaftCount, mine);

// upgrade-cost multiplier from the equipped gear (Gloves: Upgrade Discount)
const costMult = () => 1 - fx.disc;

// ore units mined per second by one floor (miners just deliver this in trips)
const floorUnitRate = (i, mine) => mine.shafts[i].level * 12 * hmult.y;
const elevatorCapacity = (level) => (level * 100 + 50) * hmult.c;
const elevatorBuff = () => hmult.s;
const elevatorTravel = (mine) => (1.4 + 0.15 * mine.elevator.level) * elevatorBuff(); // floors/sec
const elevatorStop = (mine) => 0.45 / (elevatorBuff() * (1 + 0.02 * mine.elevator.level));
const warehouseSellRate = (level) => level * 10 * (1 + fx.haste);

const serverNow = () => Date.now() + (typeof net !== "undefined" ? net.offset : 0);
const boostOn = (k) => serverNow() < (state.boosts[k] || 0);
