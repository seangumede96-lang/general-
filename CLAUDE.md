# Instructions for Claude

## Cost confirmation

Always ask the user for explicit confirmation before creating, starting, or
deleting anything that costs money. This includes (but is not limited to):

- Cloud resources (VMs, databases, storage buckets, clusters, serverless functions)
- Paid API calls, subscriptions, or plan upgrades
- Starting or scaling up services, jobs, or CI runners that bill by usage
- Deleting paid resources (deletion can be irreversible and lose data or prepaid value)

When asking, state what will be created/started/deleted, where, and the expected
cost if known. Do not proceed until the user says yes. Approval for one action
does not carry over to the next.
