# Auto Review with multiple roots

中文: [auto-review.md](./auto-review.md)

With this enabled, Auto Review also sees the additional roots' directory structure, access levels, and instruction files, and includes those roots in its review.

## Enabling it

Sidebar **Plugins** → Multi-root Workspace detail page:

- turn on the default-disabled Auto Review row in the component list, or
- turn on **Multi-root Auto Review (experimental)** on the settings card.

The two entries are equivalent and both default to off. A normal install never enables or selects Auto Review.

## Availability

The integration is available only on the DSH exact releases that ship it. Elsewhere, ordinary installation and the existing features are unaffected; only this review enhancement is missing.

## Relationship to permissions

The Auto Review enhancement only changes what the review can see. It does not change sandbox write permissions: whether an additional root can be written still depends on its access level and the session mode.
