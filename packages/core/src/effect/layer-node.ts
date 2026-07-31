import { Brand, Context, Layer } from "effect"

type AnyNode = Node<unknown, unknown, any>
type RuntimeLayer = Layer.Layer<never, unknown, unknown>
type NodeList<Item extends AnyNode = AnyNode> = readonly [] | readonly [Item, ...Item[]]
export type Output<Item> = [Item] extends [never] ? never : Item extends Node<infer A, unknown, any> ? A : never
export type Error<Item> = [Item] extends [never] ? never : Item extends Node<unknown, infer E, any> ? E : never
type NodeTag<Item> = [Item] extends [never] ? undefined : Item extends Node<unknown, unknown, infer T> ? T : never
type Missing<Required, Dependencies extends NodeList> = Exclude<Required, Output<Dependencies[number]>>
type CheckDependencies<Implementation extends Layer.Any, Dependencies extends NodeList> = [
  Missing<Layer.Services<Implementation>, Dependencies>,
] extends [never]
  ? unknown
  : { readonly "Missing dependencies": Missing<Layer.Services<Implementation>, Dependencies> }
declare const $OutputType: unique symbol
declare const $ErrorType: unique symbol

export type Tag<Name extends string = string> = Name & Brand.Brand<"LayerNode.Tag">

const makeTag = Brand.nominal<Tag>()

// altimate_change start — upstream_fix: dependencies must be resolvable lazily.
// The fork's namespace facades (Plugin/Provider/Session/...) form import cycles, so a
// consumer module can evaluate `LayerNode.make({ layer, deps: [Plugin.node, ...] })` at
// load time before the cyclically-imported facade has finished assigning its own `node`
// export, yielding `undefined` deps. Allowing `deps` to be a thunk defers reading the
// sibling `.node` references until the graph is consumed (after all modules initialize),
// which is behavior-preserving since deps are only ever read via `nodeDependencies`.
// Upstream call sites keep passing plain arrays and are unaffected.
export type LazyDeps<Items extends NodeList> = Items | (() => Items)

function nodeDependencies(node: AnyNode): readonly AnyNode[] {
  const deps = node.dependencies
  return typeof deps === "function" ? deps() : deps
}

export interface Node<A, E = never, T extends Tag | undefined = undefined> {
  readonly kind: "layer" | "unbound" | "group"
  readonly name: string
  readonly service?: Context.Service.Any
  readonly implementation?: Layer.Any
  readonly dependencies: readonly AnyNode[] | (() => readonly AnyNode[])
  readonly tag?: T
  readonly [$OutputType]?: () => A
  readonly [$ErrorType]?: () => E
}
// altimate_change end

type NodeIdentity =
  | { readonly service: Context.Service.Any; readonly name?: never }
  | { readonly name: string; readonly service?: never }
type DistributiveOmit<A, K extends PropertyKey> = A extends unknown ? Omit<A, K> : never

export type TagConfig = Readonly<Record<string, readonly string[]>>
type TagNames<Config extends TagConfig> = keyof Config & string
type NodeInTags<Names extends string> = Node<unknown, unknown, Tag<Names> | undefined>
type CheckTags<Items extends NodeList, Names extends string> = [Exclude<Items[number], NodeInTags<Names>>] extends [
  never,
]
  ? unknown
  : { readonly "Invalid tag dependencies": Exclude<Items[number], NodeInTags<Names>> }

export interface Tags<Config extends TagConfig> {
  readonly values: { readonly [Name in TagNames<Config>]: Tag<Name> }
  readonly make: <Name extends TagNames<Config>>(
    name: Name,
  ) => <const Implementation extends Layer.Any, const Items extends NodeList>(
    input: DistributiveOmit<MakeInput<Implementation, Items, Tag<Name>>, "tag"> &
      CheckTags<Items, Name | Extract<Config[Name][number], string>>,
  ) => Node<Layer.Success<Implementation>, Layer.Error<Implementation> | Error<Items[number]>, Tag<Name>>
}

export function tags<const Config extends { readonly [Name in keyof Config]: readonly (keyof Config & string)[] }>(
  config: Config,
): Tags<Config> {
  const names = Object.keys(config) as TagNames<Config>[]
  const values = Object.fromEntries(names.map((name) => [name, makeTag(name)])) as Tags<Config>["values"]
  return {
    values,
    make: ((name: TagNames<Config>) => (input: DistributiveOmit<MakeInput<Layer.Any, NodeList, Tag>, "tag">) =>
      make({ ...input, tag: values[name] })) as Tags<Config>["make"],
  }
}

// Nodes ---------------------------------------------------------------------

type MakeInput<
  Implementation extends Layer.Any,
  Items extends NodeList,
  T extends Tag | undefined = undefined,
> = NodeIdentity & {
  readonly layer: Implementation
  // altimate_change start — upstream_fix: accept lazy deps (see LazyDeps above)
  readonly deps: LazyDeps<Items> & CheckDependencies<Implementation, NoInfer<Items>>
  // altimate_change end
  readonly tag?: T
}

export function make<
  const Implementation extends Layer.Any,
  const Items extends NodeList,
  const T extends Tag | undefined = undefined,
>(
  input: MakeInput<Implementation, Items, T>,
): Node<Layer.Success<Implementation>, Layer.Error<Implementation> | Error<Items[number]>, T> {
  return {
    kind: "layer",
    name: input.service !== undefined ? input.service.key : input.name,
    service: input.service,
    implementation: input.layer,
    dependencies: input.deps,
    tag: input.tag,
  }
}

export function unbound<R, Shape, const T extends Tag>(service: Context.Key<R, Shape>, tag: T): Node<R, never, T> {
  return {
    kind: "unbound",
    name: service.key,
    service,
    dependencies: [],
    tag,
  }
}

export function group<const Items extends readonly AnyNode[]>(
  // altimate_change start — upstream_fix: accept lazy deps (see LazyDeps above)
  dependencies: Items | (() => Items),
  // altimate_change end
): Node<Output<Items[number]>, Error<Items[number]>, NodeTag<Items[number]>> {
  return { kind: "group", name: "group", dependencies }
}

export type Replacement = readonly [source: AnyNode, replacement: AnyNode | Layer.Any]
export type Replacements = readonly Replacement[]

type CheckReplacementErrors<SourceError, ReplacementError> = [Exclude<ReplacementError, SourceError>] extends [never]
  ? unknown
  : { readonly "New replacement errors": Exclude<ReplacementError, SourceError> }

type CheckReplacement<Item> = Item extends readonly [Node<infer A, infer E, infer T>, infer Replacement]
  ? Replacement extends Node<NoInfer<A>, infer E2, T>
    ? CheckReplacementErrors<E, NoInfer<E2>>
    : Replacement extends Layer.Layer<NoInfer<A>, infer E2, never>
      ? CheckReplacementErrors<E, NoInfer<E2>>
      : { readonly "Invalid replacement": Replacement }
  : { readonly "Invalid replacement": Item }

type CheckReplacements<Items extends Replacements> = {
  readonly [K in keyof Items]: CheckReplacement<Items[K]>
}

type ValidReplacements<Items extends Replacements> = Items & CheckReplacements<Items>

function replacementNode(source: AnyNode, replacement: AnyNode | Layer.Any) {
  const replacementNode = isNode(replacement)
    ? replacement
    : make({
        ...nodeMakeIdentity(source),
        layer: replacement as Layer.Layer<unknown, unknown>,
        deps: [],
        tag: source.tag,
      })
  if (source.name !== replacementNode.name) {
    throw new Error(`Cannot replace ${source.name} with ${replacementNode.name}`)
  }
  if (source.tag !== replacementNode.tag) {
    throw new Error(`Cannot replace ${source.name} across tags`)
  }
  return replacementNode
}

function nodeMakeIdentity(node: AnyNode): NodeIdentity {
  if (node.service !== undefined) return { service: node.service }
  return { name: node.name }
}

function isNode(input: Layer.Any | AnyNode): input is AnyNode {
  return "kind" in input && "dependencies" in input
}

// Tree -----------------------------------------------------------------------

type Visit<Result> = (node: AnyNode, context: VisitContext<Result>) => Result

type VisitContext<Result> = {
  readonly cache: Map<AnyNode, Result>
  readonly visit: (node: AnyNode) => Result
}

function walk<Result>(
  root: AnyNode,
  visit: Visit<Result>,
  options: {
    readonly cache?: Map<AnyNode, Result>
    readonly resolve?: (node: AnyNode) => AnyNode
    readonly detectCycles?: boolean
  } = {},
) {
  const cache = options.cache ?? new Map<AnyNode, Result>()
  const visiting = new Set<AnyNode>()
  const stack: AnyNode[] = []

  const recur = (node: AnyNode): Result => {
    const target = options.resolve?.(node) ?? node
    const cached = cache.get(target)
    if (cached !== undefined || cache.has(target)) return cached!

    if (options.detectCycles !== false && visiting.has(target)) {
      const start = stack.indexOf(target)
      throw new Error(
        `Cycle detected in layer tree: ${[...stack.slice(start), target].map((item) => item.name).join(" -> ")}`,
      )
    }

    visiting.add(target)
    stack.push(target)
    try {
      const result = visit(target, { cache, visit: recur })
      if (!cache.has(target)) cache.set(target, result)
      return result
    } finally {
      stack.pop()
      visiting.delete(target)
    }
  }

  return recur(root)
}

export function hoist<A, E, T extends Tag, const Items extends Replacements = readonly []>(
  root: Node<A, E, any>,
  tag: T,
  replacements?: ValidReplacements<Items>,
): {
  readonly node: Node<A, E>
  readonly hoisted: Node<unknown, E>
} {
  const hoisted = new Map<string, AnyNode>()
  const replacementMap = replacementMapFrom(replacements)

  const node = walk<AnyNode>(
    root,
    (node, context) => {
      if (node.kind === "group") {
        // altimate_change start — upstream_fix: resolve possibly-lazy deps
        return { ...node, dependencies: nodeDependencies(node).map(context.visit) }
        // altimate_change end
      }
      if (node.tag === tag) {
        const existing = hoisted.get(node.name)
        if (existing && existing !== node) {
          throw new Error(`Tag ${tag} has conflicting implementations for ${node.name}`)
        }
        hoisted.set(node.name, rewriteReplacementDependencies(node, replacementMap))
        return group([])
      }
      if (node.kind === "unbound") {
        return node
      }
      // altimate_change start — upstream_fix: resolve possibly-lazy deps
      return { ...node, dependencies: nodeDependencies(node).map(context.visit) }
      // altimate_change end
    },
    { resolve: (node) => replacementMap.get(node.name) ?? node },
  )

  return {
    node: node as Node<A, E>,
    hoisted: group(Array.from(hoisted.values())) as Node<unknown, E>,
  }
}

export function compile<A, E, const Items extends Replacements = readonly []>(
  root: Node<A, E, any>,
  replacements?: ValidReplacements<Items>,
): Layer.Layer<A, E> {
  const replacementMap = replacementMapFrom(replacements)
  const cache = new Map<AnyNode, RuntimeLayer>()
  const compileNode = (node: AnyNode) =>
    walk<RuntimeLayer>(
      node,
      (node, context) => {
        if (node.kind === "unbound") throw new Error(`Unbound layer node: ${node.name}`)
        // altimate_change start — upstream_fix: resolve possibly-lazy deps
        const dependencies = nodeDependencies(node).flatMap(flatten).map(context.visit)
        // altimate_change end
        const implementation = node.implementation! as RuntimeLayer
        return dependencies.length === 0
          ? implementation
          : implementation.pipe(Layer.provide(dependencies as [RuntimeLayer, ...RuntimeLayer[]]))
      },
      { cache, resolve: (node) => replacementMap.get(node.name) ?? node },
    )
  const layers = flatten(root).map((node) => compileNode(node))
  const layer = layers.reduce<RuntimeLayer>((result, layer) => layer.pipe(Layer.provideMerge(result)), Layer.empty)
  return layer as Layer.Layer<A, E>
}

function replacementMapFrom(replacements?: Replacements) {
  return (
    replacements?.reduce((map, [source, replacement]) => {
      const normalized = rewriteReplacementDependencies(replacementNode(source, replacement), map)
      const current = new Map([[source.name, normalized]])
      for (const [name, node] of map) map.set(name, rewriteReplacementDependencies(node, current))
      map.set(source.name, normalized)
      return map
    }, new Map<string, AnyNode>()) ?? new Map<string, AnyNode>()
  )
}

function rewriteReplacementDependencies(root: AnyNode, replacements: ReadonlyMap<string, AnyNode>) {
  if (replacements.size === 0) return root
  const cache = new Map<AnyNode, AnyNode>()
  const visiting = new Set<AnyNode>()
  const stack: AnyNode[] = []

  const recur = (node: AnyNode, isRoot = false): AnyNode => {
    const target = isRoot ? node : (replacements.get(node.name) ?? node)
    const cached = cache.get(target)
    if (cached !== undefined || cache.has(target)) return cached!
    if (visiting.has(target)) {
      const start = stack.indexOf(target)
      throw new Error(
        `Cycle detected in layer tree: ${[...stack.slice(start), target].map((item) => item.name).join(" -> ")}`,
      )
    }

    visiting.add(target)
    stack.push(target)
    try {
      // altimate_change start — upstream_fix: resolve possibly-lazy deps
      const targetDependencies = nodeDependencies(target)
      const dependencies = targetDependencies.map((dependency) => recur(dependency))
      const result = dependencies.every((dependency, index) => dependency === targetDependencies[index])
        ? target
        : { ...target, dependencies }
      // altimate_change end
      cache.set(target, result)
      return result
    } finally {
      stack.pop()
      visiting.delete(target)
    }
  }

  return recur(root, true)
}

export function hasUnbound(root: Node<unknown, unknown, any>, source: AnyNode): boolean {
  if (source.kind !== "unbound") throw new Error(`Cannot check non-unbound layer node: ${source.name}`)
  return walk<boolean>(root, (node, context) => {
    if (node === source) return true
    // altimate_change start — upstream_fix: resolve possibly-lazy deps
    return nodeDependencies(node).some(context.visit)
    // altimate_change end
  })
}

function flatten(node: AnyNode): readonly AnyNode[] {
  // altimate_change start — upstream_fix: resolve possibly-lazy deps
  return node.kind === "group" ? nodeDependencies(node).flatMap(flatten) : [node]
  // altimate_change end
}

export * as LayerNode from "./layer-node"
