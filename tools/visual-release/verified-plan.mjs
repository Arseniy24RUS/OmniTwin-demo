// Private process-local capabilities shared by the visual planner and existing
// create-only uploader. Serialized reports never carry these filesystem callbacks.
const plans=new WeakMap();
export function registerVisualPublicationPlan(plan,local){plans.set(plan,local);}
export function readVisualPublicationPlan(plan){return plans.get(plan);}
