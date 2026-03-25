// SecuritiesToken.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SecuritiesToken", function () {
  let identity, securitiesToken;
  let deployer, trader1, trader2, issuer, stranger;

  const TRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TRADER"));
  const ISSUER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ISSUER"));
  const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR"));
  const ONE_TOKEN = ethers.parseEther("1");
  const TWO_TOKENS = ethers.parseEther("2");
  const ZERO = BigInt(0);

  async function send(txPromise) {
    const tx = await txPromise;
    await tx.wait();
    return tx;
  }

  beforeEach(async function () {
    [deployer, trader1, trader2, issuer, stranger] = await ethers.getSigners();

    const Identity = await ethers.getContractFactory("Identity");
    identity = await Identity.deploy();
    await identity.waitForDeployment();

    await send(identity.whitelist(trader1.address, TRADER_ROLE));
    await send(identity.whitelist(trader2.address, TRADER_ROLE));
    await send(identity.whitelist(issuer.address, ISSUER_ROLE));

    const SecuritiesToken = await ethers.getContractFactory("SecuritiesToken");
    securitiesToken = await SecuritiesToken.deploy(
      "TestSecurity", "TSC", await identity.getAddress()
    );
    await securitiesToken.waitForDeployment();
  });

  describe("Deployment", function () {
    it("should have correct name", async function () {
      expect(await securitiesToken.name()).to.equal("TestSecurity");
    });

    it("should have correct symbol", async function () {
      expect(await securitiesToken.symbol()).to.equal("TSC");
    });

    it("should have 18 decimals", async function () {
      expect(await securitiesToken.decimals()).to.equal(18);
    });

    it("should have zero initial supply", async function () {
      expect(await securitiesToken.totalSupply()).to.equal(0);
    });

    it("should not be paused on deployment", async function () {
      expect(await securitiesToken.paused()).to.be.false;
    });

    it("should have correct identity contract address", async function () {
      expect(await securitiesToken.identityContract()).to.equal(
        await identity.getAddress()
      );
    });

    it("should return zero balance for any address initially", async function () {
      expect(await securitiesToken.balanceOf(trader1.address)).to.equal(0);
      expect(await securitiesToken.balanceOf(stranger.address)).to.equal(0);
    });

    it("should return zero allowance for any pair initially", async function () {
      expect(await securitiesToken.allowance(trader1.address, trader2.address)).to.equal(0);
    });

    it("should reject deployment with zero identity address", async function () {
      const SecuritiesToken = await ethers.getContractFactory("SecuritiesToken");
      await expect(
        SecuritiesToken.deploy("TestSecurity", "TSC", ethers.ZeroAddress)
      ).to.be.revertedWith("SecuritiesToken: zero identity address");
    });
  });

  describe("Minting", function () {
    it("should allow operator to mint to whitelisted address", async function () {
      await send(securitiesToken.mint(trader1.address, ONE_TOKEN));
      expect(await securitiesToken.balanceOf(trader1.address)).to.equal(ONE_TOKEN);
      expect(await securitiesToken.totalSupply()).to.equal(ONE_TOKEN);
    });

    it("should allow issuer to mint to whitelisted address", async function () {
      await send(securitiesToken.connect(issuer).mint(trader1.address, ONE_TOKEN));
      expect(await securitiesToken.balanceOf(trader1.address)).to.equal(ONE_TOKEN);
    });

    it("should allow minting zero amount", async function () {
      await send(securitiesToken.mint(trader1.address, 0));
      expect(await securitiesToken.balanceOf(trader1.address)).to.equal(0);
      expect(await securitiesToken.totalSupply()).to.equal(0);
    });

    it("should reject minting from trader role", async function () {
      await expect(
        securitiesToken.connect(trader1).mint(trader2.address, ONE_TOKEN)
      ).to.be.revertedWith("SecuritiesToken: caller is not issuer or operator");
    });

    it("should reject minting from stranger", async function () {
      await expect(
        securitiesToken.connect(stranger).mint(trader1.address, ONE_TOKEN)
      ).to.be.revertedWith("SecuritiesToken: caller is not issuer or operator");
    });

    it("should reject minting to non-whitelisted address", async function () {
      await expect(
        securitiesToken.mint(stranger.address, ONE_TOKEN)
      ).to.be.revertedWith("SecuritiesToken: recipient not whitelisted");
    });

    it("should correctly update totalSupply on multiple mints", async function () {
      await send(securitiesToken.mint(trader1.address, ONE_TOKEN));
      await send(securitiesToken.mint(trader2.address, ONE_TOKEN));
      expect(await securitiesToken.totalSupply()).to.equal(TWO_TOKENS);
    });

    it("should reject mint when paused", async function () {
      await send(securitiesToken.pause());
      await expect(
        securitiesToken.mint(trader1.address, ONE_TOKEN)
      ).to.be.revertedWith("SecuritiesToken: contract is paused");
    });
  });

  describe("Burning", function () {
    it("should allow operator to burn tokens", async function () {
      await send(securitiesToken.mint(trader1.address, ONE_TOKEN));
      await send(securitiesToken.burn(trader1.address, ONE_TOKEN));
      expect(await securitiesToken.balanceOf(trader1.address)).to.equal(0);
      expect(await securitiesToken.totalSupply()).to.equal(0);
    });

    it("should allow burning zero amount", async function () {
      await send(securitiesToken.mint(trader1.address, ONE_TOKEN));
      await send(securitiesToken.burn(trader1.address, 0));
      expect(await securitiesToken.balanceOf(trader1.address)).to.equal(ONE_TOKEN);
    });

    it("should reject burning from issuer", async function () {
      await send(securitiesToken.mint(trader1.address, ONE_TOKEN));
      await expect(
        securitiesToken.connect(issuer).burn(trader1.address, ONE_TOKEN)
      ).to.be.revertedWith("SecuritiesToken: caller is not an operator");
    });

    it("should reject burning from non-operator", async function () {
      await send(securitiesToken.mint(trader1.address, ONE_TOKEN));
      await expect(
        securitiesToken.connect(trader1).burn(trader1.address, ONE_TOKEN)
      ).to.be.revertedWith("SecuritiesToken: caller is not an operator");
    });

    it("should reject burning more than balance", async function () {
      await send(securitiesToken.mint(trader1.address, ONE_TOKEN));
      await expect(
        securitiesToken.burn(trader1.address, TWO_TOKENS)
      ).to.be.revertedWith("SecuritiesToken: insufficient balance");
    });

    it("should reject burning from zero balance", async function () {
      await expect(
        securitiesToken.burn(trader1.address, ONE_TOKEN)
      ).to.be.revertedWith("SecuritiesToken: insufficient balance");
    });

    it("should reject burn when paused", async function () {
      await send(securitiesToken.mint(trader1.address, ONE_TOKEN));
      await send(securitiesToken.pause());
      await expect(
        securitiesToken.burn(trader1.address, ONE_TOKEN)
      ).to.be.revertedWith("SecuritiesToken: contract is paused");
    });
  });

  describe("Transfer", function () {
    beforeEach(async function () {
      await send(securitiesToken.mint(trader1.address, ONE_TOKEN));
    });

    it("should allow transfer between whitelisted addresses", async function () {
      await send(securitiesToken.connect(trader1).transfer(trader2.address, ONE_TOKEN));
      expect(await securitiesToken.balanceOf(trader1.address)).to.equal(0);
      expect(await securitiesToken.balanceOf(trader2.address)).to.equal(ONE_TOKEN);
    });

    it("should allow transferring zero amount", async function () {
      await send(securitiesToken.connect(trader1).transfer(trader2.address, 0));
      expect(await securitiesToken.balanceOf(trader1.address)).to.equal(ONE_TOKEN);
      expect(await securitiesToken.balanceOf(trader2.address)).to.equal(0);
    });

    it("should allow transfer to self", async function () {
      await send(securitiesToken.connect(trader1).transfer(trader1.address, ONE_TOKEN));
      expect(await securitiesToken.balanceOf(trader1.address)).to.equal(ONE_TOKEN);
    });

    it("should reject transfer to non-whitelisted address", async function () {
      await expect(
        securitiesToken.connect(trader1).transfer(stranger.address, ONE_TOKEN)
      ).to.be.revertedWith("SecuritiesToken: recipient not whitelisted");
    });

    it("should reject transfer from non-whitelisted address", async function () {
      await send(identity.revoke(trader1.address));
      await expect(
        securitiesToken.connect(trader1).transfer(trader2.address, ONE_TOKEN)
      ).to.be.revertedWith("SecuritiesToken: sender not whitelisted");
    });

    it("should reject transfer with insufficient balance", async function () {
      await expect(
        securitiesToken.connect(trader1).transfer(trader2.address, TWO_TOKENS)
      ).to.be.revertedWith("SecuritiesToken: insufficient balance");
    });
  });

  describe("TransferFrom", function () {
    beforeEach(async function () {
      await send(securitiesToken.mint(trader1.address, ONE_TOKEN));
      await send(securitiesToken.connect(trader1).approve(deployer.address, ONE_TOKEN));
    });

    it("should allow transferFrom with sufficient allowance", async function () {
      await send(securitiesToken.transferFrom(trader1.address, trader2.address, ONE_TOKEN));
      expect(await securitiesToken.balanceOf(trader2.address)).to.equal(ONE_TOKEN);
    });

    it("should allow transferFrom where from == to", async function () {
      await send(securitiesToken.transferFrom(trader1.address, trader1.address, ONE_TOKEN));
      expect(await securitiesToken.balanceOf(trader1.address)).to.equal(ONE_TOKEN);
    });

    it("should allow transferFrom of zero amount", async function () {
      await send(securitiesToken.transferFrom(trader1.address, trader2.address, 0));
      expect(await securitiesToken.balanceOf(trader1.address)).to.equal(ONE_TOKEN);
    });

    it("should reject transferFrom with insufficient allowance", async function () {
      await expect(
        securitiesToken.transferFrom(trader1.address, trader2.address, TWO_TOKENS)
      ).to.be.revertedWith("SecuritiesToken: insufficient allowance");
    });

    it("should reject transferFrom with zero allowance", async function () {
      await send(securitiesToken.connect(trader1).approve(deployer.address, 0));
      await expect(
        securitiesToken.transferFrom(trader1.address, trader2.address, ONE_TOKEN)
      ).to.be.revertedWith("SecuritiesToken: insufficient allowance");
    });

    it("should reject transferFrom to non-whitelisted address", async function () {
      await expect(
        securitiesToken.transferFrom(trader1.address, stranger.address, ONE_TOKEN)
      ).to.be.revertedWith("SecuritiesToken: recipient not whitelisted");
    });

    it("should reject transferFrom from non-whitelisted address", async function () {
      await send(identity.revoke(trader1.address));
      await expect(
        securitiesToken.transferFrom(trader1.address, trader2.address, ONE_TOKEN)
      ).to.be.revertedWith("SecuritiesToken: sender not whitelisted");
    });

    it("should reduce allowance after transferFrom", async function () {
      await send(securitiesToken.transferFrom(trader1.address, trader2.address, ONE_TOKEN));
      expect(await securitiesToken.allowance(trader1.address, deployer.address)).to.equal(0);
    });

    it("should emit Approval event with updated allowance after transferFrom", async function () {
      const tx = await securitiesToken.transferFrom(trader1.address, trader2.address, ONE_TOKEN);
      await tx.wait();
      await expect(tx)
        .to.emit(securitiesToken, "Approval")
        .withArgs(trader1.address, deployer.address, 0);
    });
  });

  describe("Approval", function () {
    it("should allow setting allowance", async function () {
      await send(securitiesToken.connect(trader1).approve(trader2.address, ONE_TOKEN));
      expect(await securitiesToken.allowance(trader1.address, trader2.address)).to.equal(ONE_TOKEN);
    });

    it("should allow overwriting allowance", async function () {
      await send(securitiesToken.connect(trader1).approve(trader2.address, ONE_TOKEN));
      await send(securitiesToken.connect(trader1).approve(trader2.address, TWO_TOKENS));
      expect(await securitiesToken.allowance(trader1.address, trader2.address)).to.equal(TWO_TOKENS);
    });

    it("should allow setting allowance to zero", async function () {
      await send(securitiesToken.connect(trader1).approve(trader2.address, ONE_TOKEN));
      await send(securitiesToken.connect(trader1).approve(trader2.address, 0));
      expect(await securitiesToken.allowance(trader1.address, trader2.address)).to.equal(0);
    });

    it("should allow approving non-whitelisted spender", async function () {
      await send(securitiesToken.connect(trader1).approve(stranger.address, ONE_TOKEN));
      expect(await securitiesToken.allowance(trader1.address, stranger.address)).to.equal(ONE_TOKEN);
    });

    it("should reject approve to zero address", async function () {
      await expect(
        securitiesToken.connect(trader1).approve(ethers.ZeroAddress, ONE_TOKEN)
      ).to.be.revertedWith("SecuritiesToken: approve to zero address");
    });
  });

  describe("Pause", function () {
    it("should allow operator to pause", async function () {
      await send(securitiesToken.pause());
      expect(await securitiesToken.paused()).to.be.true;
    });

    it("should allow operator to unpause", async function () {
      await send(securitiesToken.pause());
      await send(securitiesToken.unpause());
      expect(await securitiesToken.paused()).to.be.false;
    });

    it("should reject pause from non-operator", async function () {
      await expect(
        securitiesToken.connect(stranger).pause()
      ).to.be.revertedWith("SecuritiesToken: caller is not an operator");
    });

    it("should reject unpause from non-operator", async function () {
      await send(securitiesToken.pause());
      await expect(
        securitiesToken.connect(stranger).unpause()
      ).to.be.revertedWith("SecuritiesToken: caller is not an operator");
    });

    it("should reject transfer when paused", async function () {
      await send(securitiesToken.mint(trader1.address, ONE_TOKEN));
      await send(securitiesToken.pause());
      await expect(
        securitiesToken.connect(trader1).transfer(trader2.address, ONE_TOKEN)
      ).to.be.revertedWith("SecuritiesToken: contract is paused");
    });

    it("should reject transferFrom when paused", async function () {
      await send(securitiesToken.mint(trader1.address, ONE_TOKEN));
      await send(securitiesToken.connect(trader1).approve(deployer.address, ONE_TOKEN));
      await send(securitiesToken.pause());
      await expect(
        securitiesToken.transferFrom(trader1.address, trader2.address, ONE_TOKEN)
      ).to.be.revertedWith("SecuritiesToken: contract is paused");
    });

    it("should allow transfer after unpause", async function () {
      await send(securitiesToken.mint(trader1.address, ONE_TOKEN));
      await send(securitiesToken.pause());
      await send(securitiesToken.unpause());
      await send(securitiesToken.connect(trader1).transfer(trader2.address, ONE_TOKEN));
      expect(await securitiesToken.balanceOf(trader2.address)).to.equal(ONE_TOKEN);
    });

    it("should reject mint when paused", async function () {
      await send(securitiesToken.pause());
      await expect(
        securitiesToken.mint(trader1.address, ONE_TOKEN)
      ).to.be.revertedWith("SecuritiesToken: contract is paused");
    });

    it("should reject burn when paused", async function () {
      await send(securitiesToken.mint(trader1.address, ONE_TOKEN));
      await send(securitiesToken.pause());
      await expect(
        securitiesToken.burn(trader1.address, ONE_TOKEN)
      ).to.be.revertedWith("SecuritiesToken: contract is paused");
    });
  });

  describe("Events", function () {
    it("should emit TokensMinted on mint", async function () {
      const tx = await securitiesToken.mint(trader1.address, ONE_TOKEN);
      await tx.wait();
      await expect(tx)
        .to.emit(securitiesToken, "TokensMinted")
        .withArgs(trader1.address, ONE_TOKEN);
    });

    it("should emit TokensBurned on burn", async function () {
      await send(securitiesToken.mint(trader1.address, ONE_TOKEN));
      const tx = await securitiesToken.burn(trader1.address, ONE_TOKEN);
      await tx.wait();
      await expect(tx)
        .to.emit(securitiesToken, "TokensBurned")
        .withArgs(trader1.address, ONE_TOKEN);
    });

    it("should emit TokensTransferred on transfer", async function () {
      await send(securitiesToken.mint(trader1.address, ONE_TOKEN));
      const tx = await securitiesToken.connect(trader1).transfer(trader2.address, ONE_TOKEN);
      await tx.wait();
      await expect(tx)
        .to.emit(securitiesToken, "TokensTransferred")
        .withArgs(trader1.address, trader2.address, ONE_TOKEN);
    });

    it("should emit Approval on approve", async function () {
      const tx = await securitiesToken.connect(trader1).approve(trader2.address, ONE_TOKEN);
      await tx.wait();
      await expect(tx)
        .to.emit(securitiesToken, "Approval")
        .withArgs(trader1.address, trader2.address, ONE_TOKEN);
    });
  });
});