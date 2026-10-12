#!/bin/sh
# The forge's own MCP server for a github job (DES-FORGE-MCP), as the worker's `forge` entry starts it. Installed as
# /usr/local/bin/forge-mcp-github. Some of github-mcp-server 2.0.2's default tools are WITHHELD: its dedicated merge
# and approval tools, so the harness does not hand the job a ready made one (CONST-MERGE-NEVER-AUTOMATIC):
# merge_pull_request merges, and pull_request_review_write submits a review whose event may be APPROVE; and the two
# that start Copilot's own agent or review, which would spend outside the job's meter (assign_copilot_to_issue,
# request_copilot_review). Withholding them is not a boundary: the job's gh, or this server run from the job's shell,
# acts with the token's permissions, and branch protection is what bounds a merge.
#
# The list is set here, after anything the entry's env holds, so no entry can clear it; it goes to the server's own
# exclusion (GITHUB_EXCLUDE_TOOLS, and the same list as --exclude-tools) and to withhold.mjs, which drops the names
# from every tool list and refuses a call to them or to any tool the server did not list. The caller's arguments
# are ignored.
WITHHELD="merge_pull_request,pull_request_review_write,assign_copilot_to_issue,request_copilot_review"
export GITHUB_EXCLUDE_TOOLS="$WITHHELD"
export GITHUB_TOOLSETS="default"
exec /usr/local/bin/node /opt/forge-mcp/withhold.mjs "$WITHHELD" -- /usr/local/bin/github-mcp-server stdio --exclude-tools="$WITHHELD"
