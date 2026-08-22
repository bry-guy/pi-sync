# Generic Kubernetes manifests

These manifests intentionally provide only the single-replica daemon, ClusterIP
service, and generic PVC. The `infra` repository must supply the site-specific
persistent volume, tailnet-only route, image pull configuration, and Argo CD
Application. Pin the deployment image by digest during rollout.
