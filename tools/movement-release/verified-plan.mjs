const plans=new WeakMap();
export function registerMovementPublicationPlan(plan,local){plans.set(plan,local);}
export function readMovementPublicationPlan(plan){return plans.get(plan);}
