/** Header carrying the gateway-verified client-cert fingerprint to the worker; the gateway strips any inbound value so a client can never set it. */
export const MachineFingerprintHeader = 'x-pragmatic-machine-fingerprint'
