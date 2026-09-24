// Synchronous FIFO, first-word-fall-through.
//
// Single clock domain. Reads are combinational: whenever `empty` is low,
// `rd_data` already shows the head of the queue, and asserting `rd_en` for one
// cycle removes it. Writes land on the clock edge when `wr_en` is high and the
// FIFO is not full.
//
// Full and empty are distinguished by carrying one extra bit on each pointer.
// Both pointers are ADDR_W+1 bits wide; the low ADDR_W bits index the memory
// and the top bit flips each time a pointer wraps. Equal pointers mean empty,
// equal index bits with different top bits mean full. See the spec in the
// exercise README for why the naive `count == DEPTH` version is a trap.

`default_nettype none

module sync_fifo #(
    parameter integer WIDTH = 8,
    parameter integer DEPTH = 8,
    // Derived from DEPTH. Do not override it at instantiation; it is in the
    // parameter list only because the `count` port needs it, and ports are
    // elaborated before the body where a localparam would live.
    parameter integer ADDR_W = $clog2(DEPTH)
) (
    input  wire             clk,
    input  wire             rst_n,

    input  wire             wr_en,
    input  wire [WIDTH-1:0] wr_data,

    input  wire             rd_en,
    output wire [WIDTH-1:0] rd_data,

    output wire             full,
    output wire             empty,
    output wire [ADDR_W:0]  count
);

    reg [WIDTH-1:0] mem [0:DEPTH-1];

    reg [ADDR_W:0] wr_ptr;
    reg [ADDR_W:0] rd_ptr;

    wire do_write = wr_en && !full;
    wire do_read  = rd_en && !empty;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            wr_ptr <= {(ADDR_W+1){1'b0}};
        end else if (do_write) begin
            wr_ptr <= wr_ptr + 1'b1;
        end
    end

    always @(posedge clk) begin
        if (do_write) begin
            mem[wr_ptr[ADDR_W-1:0]] <= wr_data;
        end
    end

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            rd_ptr <= {(ADDR_W+1){1'b0}};
        end else if (do_read) begin
            rd_ptr <= rd_ptr + 1'b1;
        end
    end

    assign rd_data = mem[rd_ptr[ADDR_W-1:0]];

    assign empty = (wr_ptr == rd_ptr);
    assign full  = (wr_ptr[ADDR_W] != rd_ptr[ADDR_W]) &&
                   (wr_ptr[ADDR_W-1:0] == rd_ptr[ADDR_W-1:0]);

    assign count = wr_ptr - rd_ptr;

endmodule

`default_nettype wire
