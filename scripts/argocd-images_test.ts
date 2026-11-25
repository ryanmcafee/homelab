#!/usr/bin/env -S bun test
import { test } from "bun:test";

import { assertEquals } from "./lib/assert.ts";
import { imageHost, imageHosts, renderedImages } from "./argocd-images.ts";

test("imageHost: an explicit registry is the first path segment", () => {
  assertEquals(imageHost("quay.io/argoproj/argocd:v3.4.4"), "quay.io");
  assertEquals(
    imageHost("ecr-public.aws.com/docker/library/redis:8"),
    "ecr-public.aws.com",
  );
  assertEquals(imageHost("localhost:5000/x:1"), "localhost:5000");
  assertEquals(imageHost("localhost/x:1"), "localhost");
});

test("imageHost: a bare or namespaced name defaults to docker.io", () => {
  assertEquals(imageHost("redis:8"), "docker.io");
  assertEquals(imageHost("library/redis:8"), "docker.io");
  assertEquals(imageHost("oliver006/redis_exporter:v1"), "docker.io");
});

test("renderedImages: containers and initContainers across documents, deduped", () => {
  const manifest = `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      initContainers:
        - name: copy
          image: quay.io/argoproj/argocd:v3
      containers:
        - name: server
          image: quay.io/argoproj/argocd:v3
---
apiVersion: apps/v1
kind: StatefulSet
spec:
  template:
    spec:
      containers:
        - name: redis
          image: ecr-public.aws.com/docker/library/redis:8
---
apiVersion: v1
kind: ConfigMap
data:
  image: not-a-container
`;
  assertEquals(renderedImages(manifest), [
    "ecr-public.aws.com/docker/library/redis:8",
    "quay.io/argoproj/argocd:v3",
  ]);
});

test("imageHosts: distinct and sorted", () => {
  assertEquals(
    imageHosts(["quay.io/a:1", "redis:8", "quay.io/b:2", "ghcr.io/c:3"]),
    ["docker.io", "ghcr.io", "quay.io"],
  );
});
