

export type TransferTargetScope = "personal" | "project"

export function defaultTransferScope(itemScope: string): TransferTargetScope {
  return itemScope === "personal" ? "project" : "personal"
}

export function transferScopeDisabled(itemScope: string, target: TransferTargetScope): boolean {
  return target === "personal" && itemScope === "personal"
}
