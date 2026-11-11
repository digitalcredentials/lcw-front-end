import { memoryResourceLogPinStore, type ResourceLogPinStore } from '@interop/vh-resource-log'

// This tab's chain-head pins for every resource log it reads (the account
// log, the annex generations, the rosters and collection logs): trust on
// first use for the tab's lifetime, as FreeWallet keeps them (its decision
// 0012). The store dies with the tab.
export const visitPins: ResourceLogPinStore = memoryResourceLogPinStore()
