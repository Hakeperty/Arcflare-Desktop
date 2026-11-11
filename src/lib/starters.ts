// A first question, for when you have a model and no idea what to ask it.
// A coding model gets coding questions; anything else gets everyday ones.
const CODE_STARTERS = [
  "Why would `for (let i = 0; i <= items.length; i++)` crash, and what's the fix?",
  "Write a shell one-liner that finds the ten largest files under this folder",
  "Explain async/await to someone who only knows callbacks, with one short example",
  "Review this for bugs (paste your function after this line):",
];
const EVERYDAY_STARTERS = [
  "I have 20 minutes and eggs, rice and spinach. What do I cook?",
  "Rewrite this so it sounds less stiff (paste your text after this line):",
  "Explain how a mortgage's interest is calculated, with real numbers",
  "What are you bad at? Be specific, so I know when to double-check you",
];
export function startersFor(modelId: string): string[] {
  return /cod(e|er|ex|estral)|devstral|flint|deepseek|starcoder|mellum|kimi|glm/i.test(modelId) ? CODE_STARTERS : EVERYDAY_STARTERS;
}
