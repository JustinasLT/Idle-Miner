"use strict";
  function researchMult() {
    let upgradeCostMult = 1;
    let elevatorCapMult = 1;
    let offlineMult = 1;
    let sellMult = 1;
    let mineMult = 1;
    for (const node of RESEARCH_NODES) {
      if (!state.researchUnlocked.includes(node.id)) continue;
      const e = node.effect;
      if (e.upgradeCostMult) upgradeCostMult *= e.upgradeCostMult;
      if (e.elevatorCapMult) elevatorCapMult *= e.elevatorCapMult;
      if (e.offlineMult) offlineMult *= e.offlineMult;
      if (e.sellMult) sellMult *= e.sellMult;
      if (e.mineMult) mineMult *= e.mineMult;
    }
    return { upgradeCostMult: upgradeCostMult * (1 - fx.disc), elevatorCapMult, offlineMult, sellMult, mineMult };
  }

  // Deeper floors hold more valuable ore: each floor is worth 2.3x the one above
  const unitValue = (i, mine) => 1.5 * Math.pow(2.3, i) * mine.prestigeMult;
  // Elevator/warehouse upgrades get pricier as you dig deeper
  const infraScale = (mine) => Math.pow(1.9, mine.unlockedShaftCount - 1);
  const minersFor = (lvl) => Math.min(4, 1 + Math.floor(lvl / 5));

  // ore units mined per second by one floor (miners just deliver this in trips)
  function floorUnitRate(i, mine, rm) {
    return mine.shafts[i].level * 12 * rm.mineMult * hmult.y * boostMult("mine");
  }

  function elevatorCapacity(level, capMult) {
    return (level * 100 + 50) * capMult * hmult.c;
  }

  function elevatorBuff(mine) {
    return boostMult("elev") * hmult.s;
  }
  const elevatorTravel = (mine) => (1.4 + 0.15 * mine.elevator.level) * elevatorBuff(mine); // floors/sec
  const elevatorStop = (mine) => 0.45 / (elevatorBuff(mine) * (1 + 0.02 * mine.elevator.level));

  // Warehouse sells much faster
  function warehouseSellRate(level, sellMult) {
    const r = level * 10 * sellMult;
    return r * (1 + fx.haste) * boostMult("sell");
  }

  function upgradeCost(base, level, multLevels, costMult) {
    let total = 0;
    for (let i = 0; i < multLevels; i++) {
      total += Math.floor(base * Math.pow(1.12, level + i) * costMult);
    }
    return total;
  }

const boostOn = (k) => Date.now() < (state.boosts[k] || 0);
const boostMult = (k) => (boostOn(k) ? BOOST_MULT[k] : 1);
// $MINE trickles out of every finished miner trip — deeper floors pay a little more
const tokenPerTrip = (i) => TOKEN_PER_TRIP * (1 + 0.12 * i);
