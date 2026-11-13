/** Negative types are checked by the dedicated tsc gate, not Vitest erasure. */
import type { RegistryRevisionBinding } from "../../../src/memory/jev/contracts.js";
import { STOCK_ESTIMATE_PROFILE } from "../../../src/memory/jev/p50-estimate.js";
declare const certified: RegistryRevisionBinding & { readonly maxTokensEnforced: true };
declare const estimate: RegistryRevisionBinding & { readonly accountingProfile: typeof STOCK_ESTIMATE_PROFILE };
const validEstimate: RegistryRevisionBinding = estimate;
const validCertified: RegistryRevisionBinding = certified;
// @ts-expect-error An estimate is mutually exclusive with certified maxTokensEnforced:true.
const falseCertification: RegistryRevisionBinding = { ...estimate, maxTokensEnforced: true };
// @ts-expect-error Certified profile cannot carry estimate accounting.
const mixed: RegistryRevisionBinding = { ...certified, accountingProfile: STOCK_ESTIMATE_PROFILE };
// @ts-expect-error Estimate assurance is explicitly serverEnforced:false.
const falseServer: typeof STOCK_ESTIMATE_PROFILE = { ...STOCK_ESTIMATE_PROFILE, serverEnforced: true };
// @ts-expect-error An arbitrary false is not a complete estimate/certified assurance.
const partial: RegistryRevisionBinding = { ...certified, maxTokensEnforced: false };
void [validEstimate, validCertified, falseCertification, mixed, falseServer, partial];
