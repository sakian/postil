/**
 * The text Claude sees when woken. It carries the whole procedure, so it still works in a long
 * session whose earlier instructions have been compacted away.
 */
export function agentHint(reviewIds: readonly number[]): string {
  const which = reviewIds.map((id) => `#${id}`).join(', ');
  return (
    `The user submitted postil review ${which} in the review UI and is waiting for you. ` +
    `For each review: call the postil get_review tool, address every thread awaiting a reply ` +
    `(change the code where asked, answer questions), reply to each thread with the reply tool, ` +
    `then call complete_review with a short summary. Only the user resolves threads.`
  );
}
