# What is Jarvix?

Jarvix is a visual AI orchestrator that allows you to create a pipeline of agents to produce an artifact. While Jarvix was created specifically to simulate the SDLC, it can be used in any way the user wants. 

Jarvix ships with a pre-made agent rooster that allows you to get started immediately. The agents are: planner, planner reviewer, architect, architect reviewer, programmer, programmer reviewer, fixer and QA.

Agents are defined as .md file (similar to regular AGENTS.md) except they do have a frontmatter section that is required for Jarvix to identify what the agent is and what it does. 

At the time of development, Qwen Code offered a 1000 requests/day free and thus Jarvix was built to use Qwen CLI as the base for it. However, it can be easily changed to use any other CLI. 

Jarvix features include:

* Agents that review each other, instead of just accepting code.

* Setting agents up with specific role categories (regular, reviewers, QA). 

* A progress graph that shows you which agent is working on what and when. 

* Modifying the graph to change agent order, roles and definitions. 

* QA MCP server that allows you to take screenshots while testing the output artifact and writing your own comments.

* Ability to pause, resume, restart and stop the agents graph at any point. 

* Saves progress of agents and the graph between sessions. 

# What is Wazear?

At one point in time, I realized I owned the domain wazear.space and I didn't own Jarvix. So instead of grapping that domain and out of fear of IP infringment I changed its name from Jarvix to Wazear.

# Why open source?

I released Wazear officially on Product Hunt, had a dedicated website and everything was set up properly. However, I had a distribution problem (I am not a marketing person) so it failed to reach the numbers that would keep it alive. 
Moreover, by the time of its release lots of CLI tools appeared (when I started working on it, they weren't). Not only that but almost all of them offer agent-based workflow (again, not the case when I started, especially Qwen CLI). 
The project has potential but it needs far more resources than I can give it -- especially on the distribution end. So I open sourced it. 


Note:

* Jarvix/Wazear is discontinued, if you want to continue working on it, feel free to fork and modify what you want. Just credit me somewhere. 
* This code was written 100% by AI.


