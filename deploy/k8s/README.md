# Generic Kubernetes manifests

These manifests provide the single-replica daemon, ClusterIP service, and
retained local PVC request required by the `infra` pi-sync deployment contract.
The `infra` repository supplies the StorageClass, namespace, tailnet-only route,
image pull Secret, and Argo CD Application. Replace the digest placeholder in
`deployment.yaml` with the published immutable GHCR digest before enabling Argo
CD.
