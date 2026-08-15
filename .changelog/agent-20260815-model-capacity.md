---
section: Changed
---

- **Model-capacity-aware diagnostic remediation (closes #1438)** — Pi-lens now tells the active model its context window, output limit, and current context usage when it delivers current turn findings. Capacity only controls batching guidance; findings stay live and the message directs the model to fix root causes instead of suppressing warnings to fit one turn.
