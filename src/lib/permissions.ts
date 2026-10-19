import type { AppRole } from "@/lib/roles";
import { hasAnyRole } from "@/lib/roles";

export function canManageCustomers(roles: AppRole[]) {
  return hasAnyRole(roles, ["seller", "admin", "manager"]);
}

export function canManageProducts(roles: AppRole[]) {
  return hasAnyRole(roles, ["admin", "manager"]);
}
