// CORS_ORIGIN is a comma-separated list. An entry may contain * to match one URL segment,
// which is how Vercel preview deployments (new URL every push) can be allowed:
//   https://fundisha-frontend-*-omarfarouqahmed05.vercel.app
// * matches letters, digits and hyphens only, so it cannot be stretched across a dot to an attacker's domain.
export function originMatcher(patterns) {
  const rules = patterns.map((pattern) => {
    if (!pattern.includes('*')) return (origin) => origin === pattern;
    const source = pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[a-z0-9-]+');
    const regex = new RegExp(`^${source}$`, 'i');
    return (origin) => regex.test(origin);
  });
  return (origin) => rules.some((matches) => matches(origin));
}
