FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

# Rename the base image's "node" user (UID 1000) to "agent".
# This keeps UID 1000 so that --userns=keep-id (Podman) and
# --user 1000:1000 (Docker) map to the correct home directory owner.
RUN usermod -d /home/agent -m -l agent node
USER agent

# Give npm global installs (Codex CLI, below) a location the non-root "agent"
# user can write to — the base image's default prefix (/usr/local) is
# root-owned.
ENV NPM_CONFIG_PREFIX="/home/agent/.npm-global"
ENV PATH="/home/agent/.local/bin:/home/agent/.npm-global/bin:$PATH"

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Install Codex CLI
RUN npm install -g @openai/codex

# Install Antigravity CLI
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash

# Cursor: only the @cursor/sdk npm package is set up here (as a project
# dependency, installed by the existing "pnpm install" onSandboxReady hook —
# see main.ts). @ai-hero/sandcastle's cursor() provider shells out to a CLI
# binary named `agent`, which @cursor/sdk does not provide; that binary needs
# its own installer and isn't part of this Dockerfile.

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
