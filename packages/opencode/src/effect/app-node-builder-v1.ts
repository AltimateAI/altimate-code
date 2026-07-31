import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"

export function build<A, E>(root: LayerNode.Node<A, E, any>, replacements: LayerNode.Replacements = []) {
  // Read the node references at call time, not module-load time — this module sits inside the
  // bootstrap/config import cycle, and an eager tuple here hits the TDZ during module evaluation.
  const bootstrapReplacement = [InstanceStore.bootstrapNode, InstanceBootstrap.node] as const
  return AppNodeBuilder.build(root, replacements.concat([bootstrapReplacement]))
}

export * as AppNodeBuilderV1 from "./app-node-builder-v1"
