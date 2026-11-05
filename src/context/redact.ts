const PATTERNS: RegExp[] = [
  /sk_[a-z]{5}-[a-z]{5}\.[A-Za-z0-9]{40}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g,
  /(password|secret|token|api_key|apikey)=\S+/gi,
  /(postgres(?:ql)?|rediss?|mysql|mongodb):\/\/[^\s:@/]*:[^\s:@/]+@/gi,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{40,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /(?:sk|rk)_live_[A-Za-z0-9]{20,}/g,
  /[A-Za-z0-9]{2,}_live_[A-Za-z0-9]{20,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /npm_[A-Za-z0-9]{36}/g,
  /hf_[A-Za-z0-9]{30,}/g,
  /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /nctx_[A-Za-z0-9]{40}/g,
  /rt_[A-Za-z0-9_-]{40,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----|$)/g,
  /^[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*\S+/gm,
];

export function redact(text: string): string {
  return PATTERNS.reduce((result, pattern) => result.replace(pattern, "[redacted]"), text);
}

export function strip_home(text: string): string {
  return text
    .replace(/(\/Users|\/home)\/[^/\s:'"]+/g, "~")
    .replace(/[A-Za-z]:\\Users\\[^\\\s:'"]+/g, "~");
}
