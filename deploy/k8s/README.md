# Generic Kubernetes manifests

These manifests provide the single-replica daemon, ClusterIP service, and
retained local PVC request required by the `infra` pi-sync deployment contract.
The `infra` repository supplies the StorageClass, namespace, tailnet-only route,
image pull Secret, and Argo CD Application.

The image digest in `deployment.yaml` is pinned by the `deploy` job of
`.github/workflows/publish-image.yml`: each push to `main` builds an image and
commits `deploy(production): <sha7>` with the new digest. Roll back by reverting
that commit.
