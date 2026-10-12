#!/bin/sh
# The forge's own MCP server for a gitlab job (DES-FORGE-MCP), as the worker's `forge` entry starts it. Installed as
# /usr/local/bin/forge-mcp-gitlab. Some of mcp-gitlab 2.1.67's tools are WITHHELD: its dedicated merge and approval
# tools, so the harness does not hand the job a ready made one (CONST-MERGE-NEVER-AUTOMATIC): merge_merge_request
# (with its auto_merge and merge_when_pipeline_succeeds), approve_merge_request, unapprove_merge_request and
# approve_deployment; discover_tools, which would grow the list past the default toolsets the job was checked
# against; and execute_graphql, which no toolset lists but whose mutations can merge, named so a later toolset
# setting cannot list it. Withholding them is not a boundary: GitLab runs quick actions (/merge, /approve) written
# in a note or a description that the listed tools post, and the job's glab, or this server run from the job's
# shell, acts with the token's role. The boundary is that role (Developer, not Maintainer) and the branch's
# protection.
#
# The list is set here, after anything the entry's env holds, so no entry can clear it. The server's own setting
# (GITLAB_TOOL_POLICY_HIDDEN) takes the names out of its list but still runs a direct call to them, and runs a call
# to a tool no toolset lists (execute_graphql), so withhold.mjs is what holds: it drops them from every tool list and
# refuses a call to them or to any tool the server did not list.
WITHHELD="merge_merge_request,approve_merge_request,unapprove_merge_request,approve_deployment,discover_tools,execute_graphql"
export GITLAB_TOOL_POLICY_HIDDEN="$WITHHELD"
# The default toolsets, whatever the entry says: a toolset or tool setting would list more than the image's proof saw.
unset GITLAB_TOOLSETS GITLAB_TOOLS
exec /usr/local/bin/node /opt/forge-mcp/withhold.mjs "$WITHHELD" -- /usr/local/bin/node /opt/forge-mcp/gitlab/node_modules/@zereight/mcp-gitlab/build/index.js
