// Where the page finds the chain, its swap program and the coins it names.
// Everything else (each coin's name, symbol and decimals, and the listings) is
// read from the chain.
//
// For development, the query string overrides the node and the swap:
//   ?node=http://127.0.0.1:28451&swap=<ContractId>&coins=<ContractId>,<ContractId>

export const DEFAULT_NODE = 'https://node1.ting-node.com';

/**
 * Per network, by ChainId: its name, the swap's ContractId once deployed, and
 * the coins the page names as known, the first of which it asks the wallet to
 * pay fees in. Any other coin is shown as one the page does not know, by the
 * name it gives itself and its ContractId.
 */
export const NETWORKS = {
  '15d6549cfacd816f835c632b4c67308d1c63e642f4cbf4049368430670705107': {
    name: 'Ting',
    swap: 'e5376baad8ced3b25f2c09f3687270b3b86ef275718828b35f195afd1e983b77',
    coins: ['305378d17f6af84a563d0f8a8455084948aff7330b62b4f2f98a44b82ba113c4'],
  },
  '8578787146be1ef0aacc797754001290272915e89cd9e5784fe1368e4c2131bc': {
    name: 'Development chain',
    swap: '',
    coins: [],
  },
};

/**
 * CodeHashes the page insists on before it makes any call link: the swap
 * program this page was written for (swap.wasm), and the reference coin,
 * which every coin it trades runs (Ting wiki: programs).
 */
export const CODE_HASHES = {
  swap: '97fdffbedaff0aa485e5536f089fe3306436ae54b8ed6691b3641bad9af0f1e0',
  coin: 'c675a4b753b61b50ae4b63cde122171f8f2bfb9a05a92df895633ca8c351e4d6',
};
