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

  const { unitValue, infraScale, minersFor, upgradeCost, shaftUnlockCost } = Shared;

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


const serverNow = () => Date.now() + (typeof net !== "undefined" ? net.offset : 0);
const boostOn = (k) => serverNow() < (state.boosts[k] || 0);
const boostMult = (k) => (boostOn(k) ? BOOST_MULT[k] : 1);

