/**
 * Retired after the Customer anchor cutover.
 * All business columns now live exclusively in CrmCustomerProfile, and the
 * legacy Customer columns no longer exist in the schema.
 */
console.error("This migration is retired: Customer business fields have already been removed. Do not run it.");
process.exitCode = 1;
