// Opaque frames expose a serviceWorker getter that throws even during feature
// detection. Report it as unavailable before game engines inspect navigator.
export function hideServiceWorker(navigator) {
  let owner = navigator;
  while (owner && !Object.hasOwn(owner, 'serviceWorker')) owner = Object.getPrototypeOf(owner);
  if (owner && Object.getOwnPropertyDescriptor(owner, 'serviceWorker').configurable) {
    delete owner.serviceWorker;
  } else if (owner) {
    Object.defineProperty(navigator, 'serviceWorker', { value: undefined, configurable: true });
  }
}
