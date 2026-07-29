/** Customer.archived was removed; archive state is solely CrmCustomerProfile.archived. */
console.error("This repair script is retired: there is no Customer archive column to reconcile.");
process.exitCode = 1;
