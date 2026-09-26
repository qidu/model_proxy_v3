Title: Getting started with GitHub Copilot CLI - GitHub Docs

FOR SHORT
```
npm install -g @github/copilot

export COPILOT_PROVIDER_TYPE=anthropic
export COPILOT_PROVIDER_BASE_URL=https://api.deepseek.com/anthropic
export COPILOT_PROVIDER_API_KEY=sk-your-deepseek-api-key
export COPILOT_MODEL=deepseek-v4-pro
```

URL Source: https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started

Markdown Content:
[Skip to main content](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started#main-content)

[GitHub Docs](https://docs.github.com/en)

Version: Free, Pro, & Team

Search or ask Copilot

Search or ask Copilot

Select language: current language is English

[Sign up](https://github.com/signup?ref_cta=Sign+up&ref_loc=docs+header&ref_page=docs)

Search or ask Copilot

Search or ask Copilot

Open menu

Collapse sidebar Expand sidebar

Scroll breadcrumbs left

1.   [Home](https://docs.github.com/en "Home")
2.   [GitHub Copilot](https://docs.github.com/en/copilot "GitHub Copilot")
3.   [How-tos](https://docs.github.com/en/copilot/how-tos "How-tos")
4.   [Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli "Copilot CLI")
5.   [Copilot CLI quickstart](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started "Copilot CLI quickstart")

Scroll breadcrumbs right

## [GitHub Copilot](https://docs.github.com/en/copilot)

*       *   [](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started#) 

*   Get started 
    *   [Quickstart](https://docs.github.com/en/copilot/get-started/quickstart) 
    *   [What is GitHub Copilot?](https://docs.github.com/en/copilot/get-started/what-is-github-copilot) 
    *   [Plans](https://docs.github.com/en/copilot/get-started/plans) 
    *   [Features](https://docs.github.com/en/copilot/get-started/features) 
    *   [Best practices](https://docs.github.com/en/copilot/get-started/best-practices) 
    *   [Enterprise AI governance](https://docs.github.com/en/copilot/get-started/enterprise-ai-governance) 

*   Concepts 
    *   Completions 
        *   [Code suggestions](https://docs.github.com/en/copilot/concepts/completions/code-suggestions) 
        *   [Code referencing](https://docs.github.com/en/copilot/concepts/completions/code-referencing) 

    *   [Chat](https://docs.github.com/en/copilot/concepts/chat) 
    *   Agents 
        *   Cloud agent 
            *   [About cloud agent](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent) 
            *   [Agent management](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/agent-management) 
            *   [Custom agents](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-custom-agents) 
            *   [About automations](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-automations) 
            *   [Access management](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/access-management) 
            *   [MCP and cloud agent](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/mcp-and-cloud-agent) 
            *   [Risks and mitigations](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations) 

        *   Copilot CLI 
            *   [About Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli) 
            *   [Comparing CLI features](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/comparing-cli-features) 
            *   [Copilot CLI in Actions](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/copilot-cli-in-github-actions) 
            *   [Cancel and roll back](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/cancel-and-roll-back) 
            *   [Context management](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/context-management) 
            *   [About remote control](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-remote-control) 
            *   [Custom agents](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-custom-agents) 
            *   [Autonomous task completion](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/autopilot) 
            *   [Parallel task execution](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/fleet) 
            *   [Researching with Copilot](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/research) 
            *   [Session data](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle) 
            *   [About rubber duck](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/rubber-duck) 
            *   [LSP servers](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/lsp-servers) 
            *   [CLI extensions](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-cli-extensions) 
            *   [Tool search](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/tool-search) 

        *   [GitHub Copilot app](https://docs.github.com/en/copilot/concepts/agents/github-copilot-app) 
        *   [Copilot in JetBrains](https://docs.github.com/en/copilot/concepts/agents/copilot-in-jetbrains) 
        *   [Code review](https://docs.github.com/en/copilot/concepts/agents/code-review) 
        *   [Agentic Workflows](https://docs.github.com/en/copilot/concepts/agents/about-github-agentic-workflows) 
        *   [Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory) 
        *   [Hooks](https://docs.github.com/en/copilot/concepts/agents/hooks) 
        *   [Plugins](https://docs.github.com/en/copilot/concepts/agents/about-plugins) 
        *   [Enterprise plugin standards](https://docs.github.com/en/copilot/concepts/agents/about-enterprise-plugin-standards) 
        *   [Third-party coding agents](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents) 
        *   [Agent apps](https://docs.github.com/en/copilot/concepts/agents/agent-apps) 
        *   [OpenAI Codex](https://docs.github.com/en/copilot/concepts/agents/openai-codex) 
        *   [Anthropic Claude](https://docs.github.com/en/copilot/concepts/agents/anthropic-claude) 
        *   [Agent skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills) 
        *   [Enterprise management](https://docs.github.com/en/copilot/concepts/agents/enterprise-management) 

    *   [Cloud and local sandboxes](https://docs.github.com/en/copilot/concepts/about-cloud-and-local-sandboxes) 
    *   [Spark](https://docs.github.com/en/copilot/concepts/spark) 
    *   Copilot usage metrics 
        *   [All articles](https://docs.github.com/en/copilot/concepts/copilot-usage-metrics) 
        *   [Copilot usage metrics](https://docs.github.com/en/copilot/concepts/copilot-usage-metrics/copilot-metrics) 

    *   Prompting 
        *   [Prompt engineering](https://docs.github.com/en/copilot/concepts/prompting/prompt-engineering) 
        *   [Response customization](https://docs.github.com/en/copilot/concepts/prompting/response-customization) 

    *   Context 
        *   [MCP](https://docs.github.com/en/copilot/concepts/context/mcp) 
        *   [Spaces](https://docs.github.com/en/copilot/concepts/context/spaces) 
        *   [Repository indexing](https://docs.github.com/en/copilot/concepts/context/repository-indexing) 
        *   [Content exclusion](https://docs.github.com/en/copilot/concepts/context/content-exclusion) 

    *   Tools 
        *   [AI tools](https://docs.github.com/en/copilot/concepts/tools/ai-tools) 
        *   [About Copilot integrations](https://docs.github.com/en/copilot/concepts/tools/about-copilot-integrations) 

    *   Models 
        *   [Bring your own key](https://docs.github.com/en/copilot/concepts/models/bring-your-own-key) 
        *   [Utility models](https://docs.github.com/en/copilot/concepts/models/utility-models) 
        *   [Auto model selection](https://docs.github.com/en/copilot/concepts/models/auto-model-selection) 
        *   [FedRAMP models](https://docs.github.com/en/copilot/concepts/models/fedramp-models) 
        *   [Base and LTS models](https://docs.github.com/en/copilot/concepts/models/fallback-and-lts-models) 

    *   [Usage limits](https://docs.github.com/en/copilot/concepts/usage-limits) 
    *   Billing 
        *   [Billing for individuals](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals) 
        *   [Billing for organizations and enterprises](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises) 
        *   [Budgets](https://docs.github.com/en/copilot/concepts/billing/budgets-for-usage-based-billing) 
        *   [Individual plans](https://docs.github.com/en/copilot/concepts/billing/individual-plans) 
        *   [Organizations and enterprises](https://docs.github.com/en/copilot/concepts/billing/organizations-and-enterprises) 

    *   [Copilot-only enterprises](https://docs.github.com/en/copilot/concepts/about-enterprise-accounts-for-copilot-business) 
    *   [Policies](https://docs.github.com/en/copilot/concepts/policies) 
    *   [MCP management](https://docs.github.com/en/copilot/concepts/mcp-management) 
    *   [Network settings](https://docs.github.com/en/copilot/concepts/network-settings) 
    *   [New features and models](https://docs.github.com/en/copilot/concepts/preparing-for-new-features-and-models) 

*   How-tos 
    *   Copilot on GitHub 
        *   Set up Copilot 
            *   Enable Copilot 
                *   [Set up for self](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/enable-copilot/set-up-for-self) 
                *   [Set up for organization](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/enable-copilot/set-up-for-organization) 
                *   [Set up for enterprise](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/enable-copilot/set-up-for-enterprise) 
                *   [Set up a dedicated enterprise](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/enable-copilot/set-up-a-dedicated-enterprise-for-copilot-business) 
                *   [Set up for students](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/enable-copilot/set-up-for-students) 
                *   [Set up for teachers and OS maintainers](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/enable-copilot/set-up-for-teachers-and-os-maintainers) 

            *   [Configure access to AI models](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-access-to-ai-models) 
            *   [Configure automatic review](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-automatic-review) 
            *   [Configure runners](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-runners) 

        *   Chat with Copilot 
            *   [Get started with chat](https://docs.github.com/en/copilot/how-tos/copilot-on-github/chat-with-copilot/get-started-with-chat) 
            *   [Chat in GitHub](https://docs.github.com/en/copilot/how-tos/copilot-on-github/chat-with-copilot/chat-in-github) 
            *   [Chat in Mobile](https://docs.github.com/en/copilot/how-tos/copilot-on-github/chat-with-copilot/chat-in-mobile) 

        *   Customize Copilot 
            *   [Customize Copilot overview](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-copilot-overview) 
            *   Add custom instructions 
                *   [Add personal instructions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-personal-instructions) 
                *   [Add repository instructions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions) 
                *   [Add organization instructions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-organization-instructions) 

            *   Customize cloud agent 
                *   [Create custom agents](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/create-custom-agents) 
                *   [Add agent skills](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills) 
                *   [Use hooks](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/use-hooks) 
                *   [Customize the agent environment](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment) 
                *   [Configure secrets and variables](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/configure-secrets-and-variables) 
                *   [Test custom agents](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/test-custom-agents) 

            *   [Customize the firewall](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-the-firewall) 
            *   [Configure MCP servers](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers) 
            *   Spaces 
                *   [Create Copilot Spaces](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/copilot-spaces/create-copilot-spaces) 
                *   [Collaborate with others](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/copilot-spaces/collaborate-with-others) 

        *   Copilot for GitHub tasks 
            *   [Use Copilot to create or update issues](https://docs.github.com/en/copilot/how-tos/copilot-on-github/copilot-for-github-tasks/use-copilot-to-create-or-update-issues) 
            *   [Create a PR summary](https://docs.github.com/en/copilot/how-tos/copilot-on-github/copilot-for-github-tasks/create-a-pr-summary) 
            *   [Use the GitHub MCP Server from Copilot Chat](https://docs.github.com/en/copilot/how-tos/copilot-on-github/copilot-for-github-tasks/using-the-github-mcp-server-from-copilot-chat) 

        *   Use Copilot agents 
            *   [Get started](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/overview) 
            *   [Kick off a task](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/kick-off-a-task) 
            *   [Research, plan, iterate](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/research-plan-iterate) 
            *   [Manage agent sessions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents) 
            *   [Copilot code review](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/copilot-code-review) 
            *   [Review Copilot output](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/review-copilot-output) 

    *   Set up 
        *   [Set up for self](https://docs.github.com/en/copilot/how-tos/set-up/set-up-for-self) 
        *   [Install Copilot extension](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-extension) 

    *   Get code suggestions 
        *   [Get IDE code suggestions](https://docs.github.com/en/copilot/how-tos/get-code-suggestions/get-ide-code-suggestions) 
        *   [Find matching code](https://docs.github.com/en/copilot/how-tos/get-code-suggestions/find-matching-code) 

    *   Chat with Copilot 
        *   [Get started with Chat in your IDE](https://docs.github.com/en/copilot/how-tos/chat-with-copilot/get-started-with-chat-in-your-ide) 
        *   [Chat in IDE](https://docs.github.com/en/copilot/how-tos/chat-with-copilot/chat-in-ide) 
        *   [Chat in Windows Terminal](https://docs.github.com/en/copilot/how-tos/chat-with-copilot/chat-in-windows-terminal) 

    *   Copilot CLI 
        *   [All articles](https://docs.github.com/en/copilot/how-tos/copilot-cli) 
        *   [Copilot CLI quickstart](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started) 
        *   [Copilot CLI best practices](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-best-practices) 
        *   Set up Copilot CLI 
            *   [Install Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli) 
            *   [Authenticate Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli) 
            *   [Configure Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/configure-copilot-cli) 
            *   [Add LSP servers](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/add-lsp-servers) 
            *   [Troubleshoot Copilot CLI auth](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/troubleshoot-copilot-cli-auth) 

        *   Use Copilot CLI 
            *   [Overview](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/overview) 
            *   [Allowing tools](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools) 
            *   [Voice input](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/voice-input) 
            *   [Connect to VS Code](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/connecting-vs-code) 
            *   [Delegate tasks to Copilot](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/delegate-tasks-to-cca) 
            *   [Browse issues, PRs, gists](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/browse-issues-prs-gists) 
            *   [Roll back changes](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/roll-back-changes) 
            *   [Invoke custom agents](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/invoke-custom-agents) 
            *   [Steer agents](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/steer-agents) 
            *   [Steer a session remotely](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/steer-remotely) 
            *   [Set an AI credit limit](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/set-session-limit) 
            *   [Agentic code review](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/agentic-code-review) 
            *   [Manage pull requests](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/manage-pull-requests) 
            *   [Speed up task completion](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/speed-up-task-completion) 
            *   [Use session data](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/chronicle) 

        *   Automate with Copilot CLI 
            *   [Quickstart](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/quickstart) 
            *   [Run the CLI programmatically](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically) 
            *   [Schedule prompts](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/schedule-prompts) 
            *   [Automate with Actions](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/automate-with-actions) 

        *   Customize Copilot CLI 
            *   [Overview](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/overview) 
            *   [Add custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions) 
            *   [Change settings](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/change-settings) 
            *   [Use hooks](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks) 
            *   [Add agent skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills) 
            *   [Add MCP servers](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers) 
            *   [Create custom agents](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli) 
            *   [Use your own model provider](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models) 
            *   [Plugins: Find and install](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-finding-installing) 
            *   [Plugins: Create a plugin](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating) 
            *   [Plugins: Create a marketplace](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-marketplace) 

        *   [Administer for enterprise](https://docs.github.com/en/copilot/how-tos/copilot-cli/administer-copilot-cli-for-your-enterprise) 
        *   [Copilot CLI in Actions](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli-in-actions) 

    *   Cloud and local sandboxes for GitHub Copilot 
        *   [Enable or disable cloud sandboxes](https://docs.github.com/en/copilot/how-tos/cloud-and-local-sandboxes/enabling-or-disabling-cloud-sandboxes-for-your-organization) 
        *   [Configure local sandbox](https://docs.github.com/en/copilot/how-tos/cloud-and-local-sandboxes/configuring-local-sandbox-settings) 

    *   GitHub Copilot app 
        *   [All articles](https://docs.github.com/en/copilot/how-tos/github-copilot-app) 
        *   [Quickstart](https://docs.github.com/en/copilot/how-tos/github-copilot-app/getting-started) 
        *   [Customize the GitHub Copilot app](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app) 
        *   [Agent sessions](https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions) 
        *   [Canvas extensions](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-canvas-extensions) 
        *   [Managing issues and pull requests](https://docs.github.com/en/copilot/how-tos/github-copilot-app/managing-issues-and-pull-requests) 
        *   [Automations](https://docs.github.com/en/copilot/how-tos/github-copilot-app/using-automations) 
        *   [Use your own model provider](https://docs.github.com/en/copilot/how-tos/github-copilot-app/use-byok-models) 
        *   [Open with deep links](https://docs.github.com/en/copilot/how-tos/github-copilot-app/open-with-deep-links) 

    *   Copilot SDK 
        *   [Getting Started](https://docs.github.com/en/copilot/how-tos/copilot-sdk/getting-started) 
        *   Authentication 
            *   [Authenticate](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate) 
            *   [BYOK](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/byok) 

        *   Features 
            *   [Agent Loop](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/agent-loop) 
            *   [Cloud Sessions](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/cloud-sessions) 
            *   [Custom Agents](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/custom-agents) 
            *   [Fleet Mode](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/fleet-mode) 
            *   [Hooks](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/hooks) 
            *   [Image Input](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/image-input) 
            *   [MCP](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/mcp) 
            *   [Plugin Directories](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/plugin-directories) 
            *   [Remote Sessions](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/remote-sessions) 
            *   [Session limits](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/session-limits) 
            *   [Session Persistence](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/session-persistence) 
            *   [Skills](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/skills) 
            *   [Steering And Queueing](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/steering-and-queueing) 
            *   [Streaming Events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events) 

        *   Use hooks 
            *   [Error Handling](https://docs.github.com/en/copilot/how-tos/copilot-sdk/hooks/error-handling) 
            *   [Hooks Overview](https://docs.github.com/en/copilot/how-tos/copilot-sdk/hooks/hooks-overview) 
            *   [Post Tool Use](https://docs.github.com/en/copilot/how-tos/copilot-sdk/hooks/post-tool-use) 
            *   [Pre Tool Use](https://docs.github.com/en/copilot/how-tos/copilot-sdk/hooks/pre-tool-use) 
            *   [Session Lifecycle](https://docs.github.com/en/copilot/how-tos/copilot-sdk/hooks/session-lifecycle) 
            *   [User Prompt Submitted](https://docs.github.com/en/copilot/how-tos/copilot-sdk/hooks/user-prompt-submitted) 

        *   Integrations 
            *   [Microsoft Agent Framework](https://docs.github.com/en/copilot/how-tos/copilot-sdk/integrations/microsoft-agent-framework) 

        *   Observability 
            *   [Opentelemetry](https://docs.github.com/en/copilot/how-tos/copilot-sdk/observability/opentelemetry) 

        *   Set up Copilot SDK 
            *   [Azure Managed Identity](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/azure-managed-identity) 
            *   [Backend Services](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/backend-services) 
            *   [Bundled CLI](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/bundled-cli) 
            *   [Choosing A Setup Path](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/choosing-a-setup-path) 
            *   [GitHub OAuth](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth) 
            *   [Local CLI](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/local-cli) 
            *   [Multi Tenancy](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/multi-tenancy) 
            *   [Scaling](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/scaling) 

        *   Troubleshooting 
            *   [Compatibility](https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/compatibility) 
            *   [Debugging](https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/debugging) 
            *   [MCP Debugging](https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/mcp-debugging) 

    *   GitHub Agentic Workflows 
        *   [Quickstart](https://docs.github.com/en/copilot/how-tos/github-agentic-workflows/quickstart) 
        *   [Creating agentic workflows](https://docs.github.com/en/copilot/how-tos/github-agentic-workflows/creating-github-agentic-workflows) 

    *   Use Copilot agents 
        *   Cloud agent 
            *   [Start Copilot sessions](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/start-copilot-sessions) 
            *   [Create cloud automations](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/create-automations) 
            *   [Changing the AI model](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/changing-the-ai-model) 
            *   [Configuring agent settings](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/configuring-agent-settings) 
            *   [Create custom agents in your IDE](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/create-custom-agents-in-your-ide) 
            *   [Use cloud agent on GitHub](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github) 
            *   [Use cloud agent on GitHub Mobile](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-mobile) 
            *   [Use agent apps](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-agent-apps) 
            *   [Use cloud agent in your IDE](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-in-your-ide) 
            *   [Use cloud agent via the API](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-via-the-api) 
            *   [Use cloud agent from the GitHub CLI](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-from-cli) 
            *   [Use cloud agent via GitHub MCP Server](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-with-mcp) 
            *   [Integrate cloud agent with Jira](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/integrate-cloud-agent-with-jira) 
            *   [Integrate cloud agent with Slack](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/integrate-cloud-agent-with-slack) 
            *   [Integrate cloud agent with Teams](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/integrate-cloud-agent-with-teams) 
            *   [Integrate cloud agent with Linear](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/integrate-cloud-agent-with-linear) 
            *   [Integrate cloud agent with Azure Boards](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/integrate-cloud-agent-with-azure-boards) 
            *   [Use cloud agent from Raycast](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-from-raycast) 
            *   [Troubleshoot cloud agent](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/troubleshoot-cloud-agent) 

        *   Request a code review 
            *   [Use code review](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review) 

        *   Copilot Memory 
            *   [Manage for yourself](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/copilot-memory/manage-for-yourself) 
            *   [Manage as administrator](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/copilot-memory/manage-as-administrator) 

    *   Use AI models 
        *   [Change the chat model](https://docs.github.com/en/copilot/how-tos/use-ai-models/change-the-chat-model) 
        *   [Change the completion model](https://docs.github.com/en/copilot/how-tos/use-ai-models/change-the-completion-model) 

    *   Provide context 
        *   Use Copilot Spaces 
            *   [Use Copilot Spaces](https://docs.github.com/en/copilot/how-tos/provide-context/use-copilot-spaces/use-copilot-spaces) 

        *   Use MCP in your IDE 
            *   [Extend Copilot Chat with MCP](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/extend-copilot-chat-with-mcp) 
            *   [Set up the GitHub MCP Server](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server) 
            *   [Enterprise configuration](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/enterprise-configuration) 
            *   [Configure toolsets](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/configure-toolsets) 
            *   [Use the GitHub MCP Server](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/use-the-github-mcp-server) 
            *   [Change MCP registry](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/change-mcp-registry) 

    *   Configure custom instructions 
        *   [Add repository instructions in your IDE](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions-in-your-ide/add-repository-instructions-in-your-ide) 

    *   Configure content exclusion 
        *   [Exclude content from Copilot](https://docs.github.com/en/copilot/how-tos/configure-content-exclusion/exclude-content-from-copilot) 
        *   [Review changes](https://docs.github.com/en/copilot/how-tos/configure-content-exclusion/review-changes) 

    *   Use Copilot for common tasks 
        *   [Use Copilot in the CLI](https://docs.github.com/en/copilot/how-tos/use-copilot-for-common-tasks/use-copilot-in-the-cli) 

    *   Configure personal settings 
        *   [Configure network settings](https://docs.github.com/en/copilot/how-tos/configure-personal-settings/configure-network-settings) 
        *   [Configure in IDE](https://docs.github.com/en/copilot/how-tos/configure-personal-settings/configure-in-ide) 
        *   [Authenticate to GHE.com](https://docs.github.com/en/copilot/how-tos/configure-personal-settings/authenticate-to-ghecom) 

    *   Manage and track spending 
        *   [Monitor AI credits usage](https://docs.github.com/en/copilot/how-tos/manage-and-track-spending/monitor-ai-usage) 
        *   [Manage company spending](https://docs.github.com/en/copilot/how-tos/manage-and-track-spending/manage-company-spending) 

    *   Manage your account 
        *   [Get started with a Copilot plan](https://docs.github.com/en/copilot/how-tos/manage-your-account/get-started-with-a-copilot-plan) 
        *   [View and change your Copilot plan](https://docs.github.com/en/copilot/how-tos/manage-your-account/view-and-change-your-copilot-plan) 
        *   [Disable Copilot Free](https://docs.github.com/en/copilot/how-tos/manage-your-account/disable-copilot-free) 
        *   [Manage policies](https://docs.github.com/en/copilot/how-tos/manage-your-account/manage-policies) 

    *   Administer Copilot 
        *   Manage for organization 
            *   Manage plan 
                *   [Cancel](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/manage-plan/cancel) 

            *   Manage access 
                *   [Grant access](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/manage-access/grant-access) 
                *   [Manage requests for access](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/manage-access/manage-requests-for-access) 
                *   [Revoke access](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/manage-access/revoke-access) 
                *   [Manage network access](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/manage-access/manage-network-access) 

            *   [Manage policies](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/manage-policies) 
            *   [Add Copilot cloud agent](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/add-copilot-cloud-agent) 
            *   [Configure agent runners](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/configure-runner-for-coding-agent) 
            *   [Prepare for custom agents](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/prepare-for-custom-agents) 
            *   [Manage default models](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/manage-default-models) 
            *   Review activity 
                *   [Review user activity data](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/review-activity/review-user-activity-data) 

            *   [Enable custom models](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/enable-custom-models) 

        *   Manage for enterprise 
            *   Manage plan 
                *   [Subscribe](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-plan/subscribe) 
                *   [Cancel plan](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-plan/cancel-plan) 
                *   [Upgrade plan](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-plan/upgrade-plan) 
                *   [Downgrade subscription](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-plan/downgrade-subscription) 

            *   Manage access 
                *   [Grant access](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-access/grant-access) 
                *   [Disable for organizations](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-access/disable-for-organizations) 
                *   [View license usage](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-access/view-license-usage) 
                *   [Manage network access](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-access/manage-network-access) 

            *   [Manage enterprise policies](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-enterprise-policies) 
            *   Manage agents 
                *   [Prepare for custom agents](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-agents/prepare-for-custom-agents) 
                *   [Create github-private repository](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-agents/create-github-private-repo) 
                *   [Enterprise managed settings](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-agents/configure-enterprise-managed-settings) 
                *   [Monitor agentic activity](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-agents/monitor-agentic-activity) 
                *   [Enable Copilot cloud agent](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-agents/enable-copilot-cloud-agent) 
                *   [Block agentic features](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-agents/block-agentic-features) 
                *   [Enable Copilot code review](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-agents/enable-copilot-code-review) 

            *   [Manage Spark](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-spark) 
            *   [Manage model availability](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-availability-of-default-models) 
            *   [Enable custom models](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/enable-custom-models) 
            *   [Review audit logs](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/review-audit-logs) 

        *   Manage MCP usage 
            *   [Configure MCP registry](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-mcp-usage/configure-mcp-registry) 
            *   [Configure MCP server access](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-mcp-usage/configure-mcp-server-access) 

        *   [Download activity report](https://docs.github.com/en/copilot/how-tos/administer-copilot/download-activity-report) 
        *   [View usage and adoption](https://docs.github.com/en/copilot/how-tos/administer-copilot/view-usage-and-adoption) 
        *   [View code generation](https://docs.github.com/en/copilot/how-tos/administer-copilot/view-code-generation) 
        *   [View impact dashboard](https://docs.github.com/en/copilot/how-tos/administer-copilot/view-impact-dashboard) 

    *   Troubleshoot Copilot 
        *   [Troubleshoot common issues](https://docs.github.com/en/copilot/how-tos/troubleshoot-copilot/troubleshoot-common-issues) 
        *   [View logs](https://docs.github.com/en/copilot/how-tos/troubleshoot-copilot/view-logs) 
        *   [Troubleshoot firewall settings](https://docs.github.com/en/copilot/how-tos/troubleshoot-copilot/troubleshoot-firewall-settings) 
        *   [Troubleshoot network errors](https://docs.github.com/en/copilot/how-tos/troubleshoot-copilot/troubleshoot-network-errors) 
        *   [Troubleshoot Spark](https://docs.github.com/en/copilot/how-tos/troubleshoot-copilot/troubleshoot-spark) 
        *   [Troubleshoot slow responses](https://docs.github.com/en/copilot/how-tos/troubleshoot-copilot/troubleshoot-copilot-slowness) 

*   Reference 
    *   [Chat cheat sheet](https://docs.github.com/en/copilot/reference/chat-cheat-sheet) 
    *   [Customization cheat sheet](https://docs.github.com/en/copilot/reference/customization-cheat-sheet) 
    *   AI models 
        *   [Supported models](https://docs.github.com/en/copilot/reference/ai-models/supported-models) 
        *   [Model comparison](https://docs.github.com/en/copilot/reference/ai-models/model-comparison) 
        *   [Model hosting](https://docs.github.com/en/copilot/reference/ai-models/model-hosting) 

    *   [Copilot feature matrix](https://docs.github.com/en/copilot/reference/copilot-feature-matrix) 
    *   [Keyboard shortcuts](https://docs.github.com/en/copilot/reference/keyboard-shortcuts) 
    *   Copilot CLI reference 
        *   [CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference) 
        *   [CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference) 
        *   [CLI programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference) 
        *   [ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) 
        *   [CLI configuration directory](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference) 

    *   [Custom agents configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration) 
    *   [Custom instructions support](https://docs.github.com/en/copilot/reference/custom-instructions-support) 
    *   [Hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference) 
    *   [Policy conflicts](https://docs.github.com/en/copilot/reference/policy-conflicts) 
    *   [Supported surfaces for policies](https://docs.github.com/en/copilot/reference/supported-surfaces-for-policies) 
    *   [Managed settings reference](https://docs.github.com/en/copilot/reference/enterprise-managed-settings-reference) 
    *   [Copilot allowlist reference](https://docs.github.com/en/copilot/reference/copilot-allowlist-reference) 
    *   [MCP allowlist enforcement](https://docs.github.com/en/copilot/reference/mcp-allowlist-enforcement) 
    *   [Metrics data](https://docs.github.com/en/copilot/reference/metrics-data) 
    *   Copilot billing 
        *   [Models and pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing) 
        *   [Billing cycle](https://docs.github.com/en/copilot/reference/copilot-billing/billing-cycle) 
        *   [Seat assignment](https://docs.github.com/en/copilot/reference/copilot-billing/seat-assignment) 
        *   [License changes](https://docs.github.com/en/copilot/reference/copilot-billing/license-changes) 
        *   [Azure billing](https://docs.github.com/en/copilot/reference/copilot-billing/azure-billing) 
        *   Request-based billing (legacy) 
            *   [What changed with billing (legacy)](https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/what-changed-with-billing) 
            *   [Copilot requests (legacy)](https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/copilot-requests) 
            *   [Billing overview (legacy)](https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/github-copilot-premium-requests) 
            *   [Monitor premium requests (legacy)](https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/monitor-premium-requests) 
            *   [Model multipliers for annual plans (legacy)](https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/model-multipliers-for-annual-plans) 

    *   [Agentic audit log events](https://docs.github.com/en/copilot/reference/agentic-audit-log-events) 
    *   [Agent session filters](https://docs.github.com/en/copilot/reference/agent-session-filters) 
    *   [Review excluded files](https://docs.github.com/en/copilot/reference/review-excluded-files) 
    *   Copilot usage metrics 
        *   [Copilot usage metrics data](https://docs.github.com/en/copilot/reference/copilot-usage-metrics/copilot-usage-metrics) 
        *   [Interpret usage metrics](https://docs.github.com/en/copilot/reference/copilot-usage-metrics/interpret-copilot-metrics) 
        *   [Reconciling Copilot usage metrics](https://docs.github.com/en/copilot/reference/copilot-usage-metrics/reconciling-usage-metrics) 
        *   [Copilot LoC metrics](https://docs.github.com/en/copilot/reference/copilot-usage-metrics/lines-of-code-metrics) 
        *   [Team-level metrics](https://docs.github.com/en/copilot/reference/copilot-usage-metrics/team-level-metrics) 
        *   [Example schema](https://docs.github.com/en/copilot/reference/copilot-usage-metrics/example-schema) 

*   Tutorials 
    *   [All tutorials](https://docs.github.com/en/copilot/tutorials) 
    *   GitHub Copilot Cookbook 
        *   [All prompts](https://docs.github.com/en/copilot/tutorials/copilot-cookbook) 
        *   Communicate effectively 
            *   [Create templates](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/communicate-effectively/creating-templates) 
            *   [Summarize repository activity](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/communicate-effectively/summarize-repository-activity) 
            *   [Synthesize research](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/communicate-effectively/synthesizing-research) 
            *   [Create diagrams](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/communicate-effectively/creating-diagrams) 
            *   [Generate tables](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/communicate-effectively/generating-tables) 

        *   Debug errors 
            *   [Debug invalid JSON](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/debug-errors/debug-invalid-json) 
            *   [Handle API rate limits](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/debug-errors/handle-api-rate-limits) 
            *   [Diagnose CI test failures](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/debug-errors/diagnose-ci-test-failures) 

        *   Analyze functionality 
            *   [Explore implementations](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/analyze-functionality/explore-implementations) 
            *   [Analyze feedback](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/analyze-functionality/analyze-feedback) 

        *   Generate code 
            *   [Implement a feature](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/generate-code/implement-a-feature) 

        *   Refactor code 
            *   [Improve code readability](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/refactor-code/improve-code-readability) 
            *   [Fix lint errors](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/refactor-code/fix-lint-errors) 
            *   [Refactor for optimization](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/refactor-code/refactor-for-optimization) 
            *   [Refactor for sustainability](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/refactor-code/refactor-for-sustainability) 
            *   [Refactor design patterns](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/refactor-code/refactor-design-patterns) 
            *   [Refactor data access layers](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/refactor-code/refactor-data-access-layers) 
            *   [Decouple business logic](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/refactor-code/decouple-business-logic) 
            *   [Handle cross-cutting](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/refactor-code/handle-cross-cutting) 
            *   [Simplify inheritance hierarchies](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/refactor-code/simplify-inheritance-hierarchies) 
            *   [Fix database deadlocks](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/refactor-code/fix-database-deadlocks) 
            *   [Translate code](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/refactor-code/translate-code) 

        *   Document code 
            *   [File issues without breaking flow](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/document-code/filing-issues-without-breaking-your-flow) 
            *   [Document legacy code](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/document-code/document-legacy-code) 
            *   [Explain legacy code](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/document-code/explain-legacy-code) 
            *   [Explain complex logic](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/document-code/explain-complex-logic) 
            *   [Sync documentation](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/document-code/sync-documentation) 
            *   [Write discussions or blog posts](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/document-code/write-discussions-or-blog-posts) 

        *   Testing code 
            *   [Generate unit tests](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/testing-code/generate-unit-tests) 
            *   [Create mock objects](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/testing-code/create-mock-objects) 
            *   [Create end-to-end tests](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/testing-code/create-end-to-end-tests) 
            *   [Update unit tests](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/testing-code/update-unit-tests) 

        *   Analyze security 
            *   [Secure your repository](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/analyze-security/secure-your-repository) 
            *   [Manage dependency updates](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/analyze-security/manage-dependency-updates) 
            *   [Find vulnerabilities](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/analyze-security/find-vulnerabilities) 

    *   Customization library 
        *   [All customizations](https://docs.github.com/en/copilot/tutorials/customization-library) 
        *   Custom instructions 
            *   [Your first custom instructions](https://docs.github.com/en/copilot/tutorials/customization-library/custom-instructions/your-first-custom-instructions) 
            *   [Concept explainer](https://docs.github.com/en/copilot/tutorials/customization-library/custom-instructions/concept-explainer) 
            *   [Debugging tutor](https://docs.github.com/en/copilot/tutorials/customization-library/custom-instructions/debugging-tutor) 
            *   [Code reviewer](https://docs.github.com/en/copilot/tutorials/customization-library/custom-instructions/code-reviewer) 
            *   [GitHub Actions helper](https://docs.github.com/en/copilot/tutorials/customization-library/custom-instructions/github-actions-helper) 
            *   [Pull request assistant](https://docs.github.com/en/copilot/tutorials/customization-library/custom-instructions/pull-request-assistant) 
            *   [Issue manager](https://docs.github.com/en/copilot/tutorials/customization-library/custom-instructions/issue-manager) 
            *   [Accessibility auditor](https://docs.github.com/en/copilot/tutorials/customization-library/custom-instructions/accessibility-auditor) 
            *   [Testing automation](https://docs.github.com/en/copilot/tutorials/customization-library/custom-instructions/testing-automation) 

        *   Prompt files 
            *   [Your first prompt file](https://docs.github.com/en/copilot/tutorials/customization-library/prompt-files/your-first-prompt-file) 
            *   [Create README](https://docs.github.com/en/copilot/tutorials/customization-library/prompt-files/create-readme) 
            *   [Onboarding plan](https://docs.github.com/en/copilot/tutorials/customization-library/prompt-files/onboarding-plan) 
            *   [Document API](https://docs.github.com/en/copilot/tutorials/customization-library/prompt-files/document-api) 
            *   [Review code](https://docs.github.com/en/copilot/tutorials/customization-library/prompt-files/review-code) 
            *   [Generate unit tests](https://docs.github.com/en/copilot/tutorials/customization-library/prompt-files/generate-unit-tests) 

        *   Custom agents 
            *   [Your first custom agent](https://docs.github.com/en/copilot/tutorials/customization-library/custom-agents/your-first-custom-agent) 
            *   [Implementation planner](https://docs.github.com/en/copilot/tutorials/customization-library/custom-agents/implementation-planner) 
            *   [Bug fix teammate](https://docs.github.com/en/copilot/tutorials/customization-library/custom-agents/bug-fix-teammate) 
            *   [Cleanup specialist](https://docs.github.com/en/copilot/tutorials/customization-library/custom-agents/cleanup-specialist) 

    *   Cloud agent 
        *   [Get the best results](https://docs.github.com/en/copilot/tutorials/cloud-agent/get-the-best-results) 
        *   [Pilot cloud agent](https://docs.github.com/en/copilot/tutorials/cloud-agent/pilot-cloud-agent) 
        *   [Improve a project](https://docs.github.com/en/copilot/tutorials/cloud-agent/improve-a-project) 
        *   [Build guardrails](https://docs.github.com/en/copilot/tutorials/cloud-agent/build-guardrails) 
        *   [Give access to resources](https://docs.github.com/en/copilot/tutorials/cloud-agent/give-access-to-resources) 

    *   Set up budgets 
        *   [Get started with budgets](https://docs.github.com/en/copilot/tutorials/budgets/getting-started-with-budget-controls) 
        *   [Optimize budget configuration](https://docs.github.com/en/copilot/tutorials/budgets/optimizing-your-budget-configuration) 

    *   Spark 
        *   [Your first spark](https://docs.github.com/en/copilot/tutorials/spark/your-first-spark) 
        *   [Prompt tips](https://docs.github.com/en/copilot/tutorials/spark/prompt-tips) 
        *   [Build and deploy apps](https://docs.github.com/en/copilot/tutorials/spark/build-apps-with-spark) 
        *   [Deploy from CLI](https://docs.github.com/en/copilot/tutorials/spark/deploy-from-cli) 

    *   [Customize code review](https://docs.github.com/en/copilot/tutorials/customize-code-review) 
    *   [Pull request lifecycle](https://docs.github.com/en/copilot/tutorials/use-copilot-code-review-across-the-pull-request-lifecycle) 
    *   [Enhance agent mode with MCP](https://docs.github.com/en/copilot/tutorials/enhance-agent-mode-with-mcp) 
    *   [Compare AI models](https://docs.github.com/en/copilot/tutorials/compare-ai-models) 
    *   [Speed up development work](https://docs.github.com/en/copilot/tutorials/speed-up-development-work) 
    *   Roll out at scale 
        *   Assign licenses 
            *   [Choose enterprise plan](https://docs.github.com/en/copilot/tutorials/roll-out-at-scale/assign-licenses/choose-enterprise-plan) 
            *   [Set up self-serve licenses](https://docs.github.com/en/copilot/tutorials/roll-out-at-scale/assign-licenses/set-up-self-serve-licenses) 
            *   [Track usage and adoption](https://docs.github.com/en/copilot/tutorials/roll-out-at-scale/assign-licenses/track-usage-and-adoption) 
            *   [Remind inactive users](https://docs.github.com/en/copilot/tutorials/roll-out-at-scale/assign-licenses/remind-inactive-users) 

        *   Govern at scale 
            *   [Resources for approval](https://docs.github.com/en/copilot/tutorials/roll-out-at-scale/govern-at-scale/resources-for-approval) 
            *   [Establish AI managers](https://docs.github.com/en/copilot/tutorials/roll-out-at-scale/govern-at-scale/establish-ai-managers) 
            *   [Govern for adoption](https://docs.github.com/en/copilot/tutorials/roll-out-at-scale/govern-at-scale/govern-for-adoption) 
            *   [Pilot a feature or model](https://docs.github.com/en/copilot/tutorials/roll-out-at-scale/govern-at-scale/pilot-a-feature-or-model) 
            *   [Maintain codebase standards](https://docs.github.com/en/copilot/tutorials/roll-out-at-scale/govern-at-scale/maintain-codebase-standards) 

        *   Enable developers 
            *   [Drive adoption](https://docs.github.com/en/copilot/tutorials/roll-out-at-scale/enable-developers/drive-adoption) 
            *   [Integrate AI agents](https://docs.github.com/en/copilot/tutorials/roll-out-at-scale/enable-developers/integrate-ai-agents) 

        *   Drive downstream impact 
            *   [Achieve company goals](https://docs.github.com/en/copilot/tutorials/roll-out-at-scale/drive-downstream-impact/achieve-company-goals) 
            *   [Increase test coverage](https://docs.github.com/en/copilot/tutorials/roll-out-at-scale/drive-downstream-impact/increase-test-coverage) 
            *   [Accelerate pull requests](https://docs.github.com/en/copilot/tutorials/roll-out-at-scale/drive-downstream-impact/accelerate-pull-requests) 
            *   [Reduce security debt](https://docs.github.com/en/copilot/tutorials/roll-out-at-scale/drive-downstream-impact/reduce-security-debt) 

        *   [Measure trial success](https://docs.github.com/en/copilot/tutorials/roll-out-at-scale/measure-success) 

    *   [Explore a codebase](https://docs.github.com/en/copilot/tutorials/explore-a-codebase) 
    *   [Explore issues and discussions](https://docs.github.com/en/copilot/tutorials/explore-issues-and-discussions) 
    *   [Explore pull requests](https://docs.github.com/en/copilot/tutorials/explore-pull-requests) 
    *   [Write tests](https://docs.github.com/en/copilot/tutorials/write-tests) 
    *   [Refactor code](https://docs.github.com/en/copilot/tutorials/refactor-code) 
    *   [Optimize AI usage](https://docs.github.com/en/copilot/tutorials/optimize-ai-usage) 
    *   [Optimize code reviews](https://docs.github.com/en/copilot/tutorials/optimize-code-reviews) 
    *   [Reduce technical debt](https://docs.github.com/en/copilot/tutorials/reduce-technical-debt) 
    *   [Review AI code](https://docs.github.com/en/copilot/tutorials/review-ai-generated-code) 
    *   [Learn a new language](https://docs.github.com/en/copilot/tutorials/learn-a-new-language) 
    *   [Modernize legacy code](https://docs.github.com/en/copilot/tutorials/modernize-legacy-code) 
    *   [Modernize Java applications](https://docs.github.com/en/copilot/tutorials/modernize-java-applications) 
    *   [Migrate a project](https://docs.github.com/en/copilot/tutorials/migrate-a-project) 
    *   [Plan a project](https://docs.github.com/en/copilot/tutorials/plan-a-project) 
    *   [Vibe coding](https://docs.github.com/en/copilot/tutorials/vibe-coding) 
    *   [Upgrade projects](https://docs.github.com/en/copilot/tutorials/upgrade-projects) 
    *   [Use hooks with Copilot CLI](https://docs.github.com/en/copilot/tutorials/copilot-cli-hooks) 
    *   [Use an AI SME](https://docs.github.com/en/copilot/tutorials/use-an-ai-sme) 
    *   [Create CLI extensions](https://docs.github.com/en/copilot/tutorials/create-an-extension) 

*   Responsible use 
    *   [Chat](https://docs.github.com/en/copilot/responsible-use/chat) 
    *   [Inline suggestions](https://docs.github.com/en/copilot/responsible-use/inline-suggestions) 
    *   [Agents](https://docs.github.com/en/copilot/responsible-use/agents) 

# Getting started with GitHub Copilot CLI

Quickly learn how to use GitHub Copilot CLI.

## Who can use this feature?

GitHub Copilot CLI is available with all Copilot plans. If you receive Copilot from an organization, the Copilot CLI policy must be enabled in the organization's settings.

Copy as Markdown

## In this article

*   [Introduction](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started#introduction)
*   [Installation](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started#installation)
*   [Starting the CLI for the first time](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started#starting-the-cli-for-the-first-time)
*   [Core shortcuts to master](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started#core-shortcuts-to-master)
*   [Using GitHub Copilot CLI non-interactively](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started#using-github-copilot-cli-non-interactively)
*   [Next steps](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started#next-steps)

## [Introduction](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started#introduction)

GitHub Copilot CLI is a powerful terminal-native AI coding assistant that brings agentic capabilities directly to your command line. The Copilot CLI offers deep flexibility, GitHub workflow integration, and the ability to work autonomously on complex tasks while maintaining full user control.

This guide will help you start using the CLI.

## [Installation](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started#installation)

Use one of these commands:

*   **Cross-platform (npm)**

Prerequisite: Node.js 22 or later.

Bash npm install -g @github/copilot

```bash
npm install -g @github/copilot
``` 
*   **Windows (WinGet)**

Bash winget install GitHub.Copilot

```bash
winget install GitHub.Copilot
``` 
*   **macOS/Linux (Homebrew)**

Bash brew install --cask copilot-cli

```bash
brew install --cask copilot-cli
``` 

## [Starting the CLI for the first time](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started#starting-the-cli-for-the-first-time)

1.   In the terminal, navigate to the project directory where you want to use Copilot CLI.

2.   Start an interactive CLI session:

```bash
copilot
```
3.   In the CLI interface, enter `/login` and follow the on-screen prompts to authenticate with your GitHub account.

You'll only have to do this the first time you use the CLI.

4.   When prompted, confirm that you trust that the files in the current directory are suitable for use with an AI tool.

Note

Copilot won't make changes to your files without your explicit approval. 
5.   Try asking Copilot a question, for example:

Copilot prompt Give me an overview of this project.

```copilot
Give me an overview of this project.
``` 
If you like, you can speak your prompt instead of typing it. See [Use voice input with Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/voice-input).

## [Core shortcuts to master](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started#core-shortcuts-to-master)

| Shortcut | Action |
| --- | --- |
| Esc | Cancel the current operation |
| Ctrl+C | Cancel if thinking, clear input, or exit |
| Ctrl+L | Clear the screen |
| `@` | Mention files to include in context |
| `/` | Show slash commands |
| `?` | Show tabbed help |
| ↑ and ↓ | Navigate the command history |

For a full list of shortcuts and available commands, enter:

```bash
/help
```

## [Using GitHub Copilot CLI non-interactively](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started#using-github-copilot-cli-non-interactively)

You can also enter a command and get a response from Copilot directly in your terminal, without starting an interactive session.

To do this, pass a prompt to the CLI with the `-p` flag. For example:

```bash
copilot -p "In Git, how can I apply a commit from another branch"
```

The `-p` flag allows you to use GitHub Copilot CLI programmatically within scripts, for example to automate tasks using AI.

You can add the `-s` flag to tell the CLI to output only Copilot's response, omitting the additional usage information.

```bash
copilot -sp "YOUR PROMPT HERE"
```

For details of other flags you can use programmatically, and for more information, enter:

```bash
copilot help
```

or:

```bash
copilot help TOPIC
```

where TOPIC is one of the topics listed in the help output.

## [Next steps](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started#next-steps)

Find out more about Copilot CLI:

*   [About GitHub Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli)
*   [Using GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/overview)
*   [Best practices for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-best-practices)
*   [Get started with GitHub Copilot CLI: A free hands-on course](https://developer.microsoft.com/blog/get-started-with-github-copilot-cli-a-free-hands-on-course)

## Help and support

### Did you find what you needed?

Yes No 

[Privacy policy](https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement)

### Help us make these docs great!

All GitHub docs are open source. See something that's wrong or unclear? Submit a pull request.

[Make a contribution](https://github.com/github/docs/blob/main/content/copilot/how-tos/copilot-cli/cli-getting-started.md)
[Learn how to contribute](https://docs.github.com/contributing)

### Still need help?

[Ask the GitHub community](https://github.com/orgs/community/discussions)

[Contact support](https://support.github.com/)

## Legal

*   © 2026 GitHub, Inc.
*   [Terms](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)
*   [Privacy](https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement)
*   [Status](https://www.githubstatus.com/)
*   [Pricing](https://github.com/pricing)
*   [Expert services](https://services.github.com/)
*   [Blog](https://github.blog/)

