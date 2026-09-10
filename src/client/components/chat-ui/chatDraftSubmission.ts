

export async function runRetainedDraftSubmission(options: {
  submit: () => Promise<void>
  onAccepted: () => void
  onRejected: (error: unknown) => void
}): Promise<void> {
  try {
    await options.submit()
    options.onAccepted()
  } catch (error) {
    options.onRejected(error)
  }
}
