require("@nomicfoundation/hardhat-toolbox");

module.exports = {
  solidity: "0.8.28",
  networks: {
    besu: {
      url: "http://localhost:8545",
      chainId: 1337,
      accounts: [
        "0x1ca60577f0b6dbf9ebddeb330615c25824f2e458eed044b0abc3ac954eb1f3db",
        "0xae6ae8e5ccbfb04590405997ee2d52d2b330726137b875053c36d94e974d162f",
        "0x0dbbe8e4ae425a6d2687f1a7e3ba17bc98c673636790f1b8ad91193c05875ef1",
        "0xc88b703fb08cbea894b6aeff5a544fb92e78a18e19814cd85da83b71f772aa6c",
        "0x388c684f0ba1ef5017716adb5d21a053ea8e90277d0868337519f97bede61418"
      ]
    }
  }
};