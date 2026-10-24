#!/usr/bin/perl
# 通过 event4(fake-keys) 注入 HOME 键
use strict; use warnings;
open(my $fh, ">", "/dev/input/event4") or die "open ev4: $!";
binmode($fh);
sub ev { my ($t,$c,$v)=@_; print $fh pack("LLSSl",0,0,$t,$c,$v); }
ev(1,102,1); ev(0,0,0); select(undef,undef,undef,0.05); ev(1,102,0); ev(0,0,0);
close($fh); print "injected HOME via event4\n";
