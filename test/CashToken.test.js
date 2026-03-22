const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("CashToken", function () {
  let identity, cashToken;
  let deployer, trader1, trader2, issuer, stranger;

  const TRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TRADER"));
  const ISSUER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ISSUER"));
  const ONE_TOKEN = ethers.parseEther("1");
  const TWO_TOKENS = ethers.parseEther("2");

  beforeEach(async function () {
    [deployer, trader1, trader2, issuer, stranger] = await ethers.getSigners();

    const Identity = await ethers.getContractFactory("Identity");
    identity = await Identity.deploy();
    await identity.waitForDeployment();

    await identity.whitelist(trader1.address, TRADER_ROLE);
    await identity.whitelist(trader2.address, TRADER_ROLE);
    await identity.whitelist(issuer.address, ISSUER_ROLE);

    const CashToken = await ethers.getContractFactory("CashToken");
    cashToken = await CashToken.deploy(
      "TokenizedEUR", "tEUR", await identity.getAddress()
    );
    await cashToken.waitForDeployment();
  });

  describe("Deployment", function () {
    it("should have correct name", async function () {
      expect(await cashToken.name()).to.equal("TokenizedEUR");
    });

    it("should have correct symbol", async function () {
      expect(await cashToken.symbol()).to.equal("tEUR");
    });

    it("should have 18 decimals", async function () {
      expect(await cashToken.decimals()).to.equal(18);
    });

    it("should have zero initial supply", async function () {
      expect(await cashToken.totalSupply()).to.equal(0);
    });

    it("should not be paused on deployment", async function () {
      expect(await cashToken.paused()).to.be.false;
    });

    it("should return zero balance for any address initially", async function () {
      expect(await cashToken.balanceOf(trader1.address)).to.equal(0);
      expect(await cashToken.balanceOf(stranger.address)).to.equal(0);
    });

    it("should return zero allowance for any pair initially", async function () {
      expect(await cashToken.allowance(trader1.address, trader2.address)).to.equal(0);
    });
  });

  describe("Minting", function () {
    it("should allow operator to mint to whitelisted address", async function () {
      await cashToken.mint(trader1.address, ONE_TOKEN);
      expect(await cashToken.balanceOf(trader1.address)).to.equal(ONE_TOKEN);
      expect(await cashToken.totalSupply()).to.equal(ONE_TOKEN);
    });

    it("should allow minting zero amount", async function () {
      await cashToken.mint(trader1.address, 0);
      expect(await cashToken.balanceOf(trader1.address)).to.equal(0);
    });

    it("should reject minting from issuer role", async function () {
      await expect(
        cashToken.connect(issuer).mint(trader1.address, ONE_TOKEN)
      ).to.be.revertedWith("CashToken: caller is not an operator");
    });

    it("should reject minting from trader role", async function () {
      await expect(
        cashToken.connect(trader1).mint(trader2.address, ONE_TOKEN)
      ).to.be.revertedWith("CashToken: caller is not an operator");
    });

    it("should reject minting from stranger", async function () {
      await expect(
        cashToken.connect(stranger).mint(trader1.address, ONE_TOKEN)
      ).to.be.revertedWith("CashToken: caller is not an operator");
    });

    it("should reject minting to non-whitelisted address", async function () {
      await expect(
        cashToken.mint(stranger.address, ONE_TOKEN)
      ).to.be.revertedWith("CashToken: recipient not whitelisted");
    });

    it("should correctly update totalSupply on multiple mints", async function () {
      await cashToken.mint(trader1.address, ONE_TOKEN);
      await cashToken.mint(trader2.address, ONE_TOKEN);
      expect(await cashToken.totalSupply()).to.equal(TWO_TOKENS);
    });
  });

  describe("Burning", function () {
    it("should allow operator to burn tokens", async function () {
      await cashToken.mint(trader1.address, ONE_TOKEN);
      await cashToken.burn(trader1.address, ONE_TOKEN);
      expect(await cashToken.balanceOf(trader1.address)).to.equal(0);
      expect(await cashToken.totalSupply()).to.equal(0);
    });

    it("should allow burning zero amount", async function () {
      await cashToken.mint(trader1.address, ONE_TOKEN);
      await cashToken.burn(trader1.address, 0);
      expect(await cashToken.balanceOf(trader1.address)).to.equal(ONE_TOKEN);
    });

    it("should reject burning from non-operator", async function () {
      await cashToken.mint(trader1.address, ONE_TOKEN);
      await expect(
        cashToken.connect(trader1).burn(trader1.address, ONE_TOKEN)
      ).to.be.revertedWith("CashToken: caller is not an operator");
    });

    it("should reject burning from issuer", async function () {
      await cashToken.mint(trader1.address, ONE_TOKEN);
      await expect(
        cashToken.connect(issuer).burn(trader1.address, ONE_TOKEN)
      ).to.be.revertedWith("CashToken: caller is not an operator");
    });

    it("should reject burning more than balance", async function () {
      await cashToken.mint(trader1.address, ONE_TOKEN);
      await expect(
        cashToken.burn(trader1.address, TWO_TOKENS)
      ).to.be.revertedWith("CashToken: insufficient balance");
    });

    it("should reject burning from zero balance", async function () {
      await expect(
        cashToken.burn(trader1.address, ONE_TOKEN)
      ).to.be.revertedWith("CashToken: insufficient balance");
    });
  });

  describe("Transfer", function () {
    beforeEach(async function () {
      await cashToken.mint(trader1.address, ONE_TOKEN);
    });

    it("should allow transfer between whitelisted addresses", async function () {
      await cashToken.connect(trader1).transfer(trader2.address, ONE_TOKEN);
      expect(await cashToken.balanceOf(trader1.address)).to.equal(0);
      expect(await cashToken.balanceOf(trader2.address)).to.equal(ONE_TOKEN);
    });

    it("should allow transferring zero amount", async function () {
      await cashToken.connect(trader1).transfer(trader2.address, 0);
      expect(await cashToken.balanceOf(trader1.address)).to.equal(ONE_TOKEN);
    });

    it("should allow transfer to self", async function () {
      await cashToken.connect(trader1).transfer(trader1.address, ONE_TOKEN);
      expect(await cashToken.balanceOf(trader1.address)).to.equal(ONE_TOKEN);
    });

    it("should reject transfer to non-whitelisted address", async function () {
      await expect(
        cashToken.connect(trader1).transfer(stranger.address, ONE_TOKEN)
      ).to.be.revertedWith("CashToken: recipient not whitelisted");
    });

    it("should reject transfer from non-whitelisted address", async function () {
      await identity.revoke(trader1.address);
      await expect(
        cashToken.connect(trader1).transfer(trader2.address, ONE_TOKEN)
      ).to.be.revertedWith("CashToken: sender not whitelisted");
    });

    it("should reject transfer with insufficient balance", async function () {
      await expect(
        cashToken.connect(trader1).transfer(trader2.address, TWO_TOKENS)
      ).to.be.revertedWith("CashToken: insufficient balance");
    });
  });

  describe("TransferFrom", function () {
    beforeEach(async function () {
      await cashToken.mint(trader1.address, ONE_TOKEN);
      await cashToken.connect(trader1).approve(deployer.address, ONE_TOKEN);
    });

    it("should allow transferFrom with sufficient allowance", async function () {
      await cashToken.transferFrom(trader1.address, trader2.address, ONE_TOKEN);
      expect(await cashToken.balanceOf(trader2.address)).to.equal(ONE_TOKEN);
    });

    it("should allow transferFrom where from == to", async function () {
      await cashToken.transferFrom(trader1.address, trader1.address, ONE_TOKEN);
      expect(await cashToken.balanceOf(trader1.address)).to.equal(ONE_TOKEN);
    });

    it("should allow transferFrom of zero amount", async function () {
      await cashToken.transferFrom(trader1.address, trader2.address, 0);
      expect(await cashToken.balanceOf(trader1.address)).to.equal(ONE_TOKEN);
    });

    it("should reject transferFrom with insufficient allowance", async function () {
      await expect(
        cashToken.transferFrom(trader1.address, trader2.address, TWO_TOKENS)
      ).to.be.revertedWith("CashToken: insufficient allowance");
    });

    it("should reject transferFrom with zero allowance", async function () {
      await cashToken.connect(trader1).approve(deployer.address, 0);
      await expect(
        cashToken.transferFrom(trader1.address, trader2.address, ONE_TOKEN)
      ).to.be.revertedWith("CashToken: insufficient allowance");
    });

    it("should reject transferFrom to non-whitelisted address", async function () {
      await expect(
        cashToken.transferFrom(trader1.address, stranger.address, ONE_TOKEN)
      ).to.be.revertedWith("CashToken: recipient not whitelisted");
    });

    it("should reject transferFrom from non-whitelisted address", async function () {
      await identity.revoke(trader1.address);
      await expect(
        cashToken.transferFrom(trader1.address, trader2.address, ONE_TOKEN)
      ).to.be.revertedWith("CashToken: sender not whitelisted");
    });

    it("should reduce allowance after transferFrom", async function () {
      await cashToken.transferFrom(trader1.address, trader2.address, ONE_TOKEN);
      expect(await cashToken.allowance(trader1.address, deployer.address)).to.equal(0);
    });
  });

  describe("Approval", function () {
    it("should allow setting allowance", async function () {
      await cashToken.connect(trader1).approve(trader2.address, ONE_TOKEN);
      expect(await cashToken.allowance(trader1.address, trader2.address)).to.equal(ONE_TOKEN);
    });

    it("should allow overwriting allowance", async function () {
      await cashToken.connect(trader1).approve(trader2.address, ONE_TOKEN);
      await cashToken.connect(trader1).approve(trader2.address, TWO_TOKENS);
      expect(await cashToken.allowance(trader1.address, trader2.address)).to.equal(TWO_TOKENS);
    });

    it("should allow setting allowance to zero", async function () {
      await cashToken.connect(trader1).approve(trader2.address, ONE_TOKEN);
      await cashToken.connect(trader1).approve(trader2.address, 0);
      expect(await cashToken.allowance(trader1.address, trader2.address)).to.equal(0);
    });

    it("should allow approving non-whitelisted spender", async function () {
      await cashToken.connect(trader1).approve(stranger.address, ONE_TOKEN);
      expect(await cashToken.allowance(trader1.address, stranger.address)).to.equal(ONE_TOKEN);
    });
  });

  describe("Pause", function () {
    it("should allow operator to pause", async function () {
      await cashToken.pause();
      expect(await cashToken.paused()).to.be.true;
    });

    it("should allow operator to unpause", async function () {
      await cashToken.pause();
      await cashToken.unpause();
      expect(await cashToken.paused()).to.be.false;
    });

    it("should reject pause from non-operator", async function () {
      await expect(
        cashToken.connect(stranger).pause()
      ).to.be.revertedWith("CashToken: caller is not an operator");
    });

    it("should reject unpause from non-operator", async function () {
      await cashToken.pause();
      await expect(
        cashToken.connect(stranger).unpause()
      ).to.be.revertedWith("CashToken: caller is not an operator");
    });

    it("should reject transfer when paused", async function () {
      await cashToken.mint(trader1.address, ONE_TOKEN);
      await cashToken.pause();
      await expect(
        cashToken.connect(trader1).transfer(trader2.address, ONE_TOKEN)
      ).to.be.revertedWith("CashToken: contract is paused");
    });

    it("should reject transferFrom when paused", async function () {
      await cashToken.mint(trader1.address, ONE_TOKEN);
      await cashToken.connect(trader1).approve(deployer.address, ONE_TOKEN);
      await cashToken.pause();
      await expect(
        cashToken.transferFrom(trader1.address, trader2.address, ONE_TOKEN)
      ).to.be.revertedWith("CashToken: contract is paused");
    });

    it("should allow transfer after unpause", async function () {
      await cashToken.mint(trader1.address, ONE_TOKEN);
      await cashToken.pause();
      await cashToken.unpause();
      await cashToken.connect(trader1).transfer(trader2.address, ONE_TOKEN);
      expect(await cashToken.balanceOf(trader2.address)).to.equal(ONE_TOKEN);
    });

    it("should allow mint when paused", async function () {
      await cashToken.pause();
      await cashToken.mint(trader1.address, ONE_TOKEN);
      expect(await cashToken.balanceOf(trader1.address)).to.equal(ONE_TOKEN);
    });

    it("should allow burn when paused", async function () {
      await cashToken.mint(trader1.address, ONE_TOKEN);
      await cashToken.pause();
      await cashToken.burn(trader1.address, ONE_TOKEN);
      expect(await cashToken.balanceOf(trader1.address)).to.equal(0);
    });
  });

  describe("Events", function () {
    it("should emit TokensMinted on mint", async function () {
      await expect(cashToken.mint(trader1.address, ONE_TOKEN))
        .to.emit(cashToken, "TokensMinted")
        .withArgs(trader1.address, ONE_TOKEN);
    });

    it("should emit TokensBurned on burn", async function () {
      await cashToken.mint(trader1.address, ONE_TOKEN);
      await expect(cashToken.burn(trader1.address, ONE_TOKEN))
        .to.emit(cashToken, "TokensBurned")
        .withArgs(trader1.address, ONE_TOKEN);
    });

    it("should emit TokensTransferred on transfer", async function () {
      await cashToken.mint(trader1.address, ONE_TOKEN);
      await expect(cashToken.connect(trader1).transfer(trader2.address, ONE_TOKEN))
        .to.emit(cashToken, "TokensTransferred")
        .withArgs(trader1.address, trader2.address, ONE_TOKEN);
    });

    it("should emit Approval on approve", async function () {
      await expect(cashToken.connect(trader1).approve(trader2.address, ONE_TOKEN))
        .to.emit(cashToken, "Approval")
        .withArgs(trader1.address, trader2.address, ONE_TOKEN);
    });
  });
});