package main

import (
	"os"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/cli"
)

func main() {
	os.Exit(cli.New(os.Stdout, os.Stderr).Run(os.Args[1:]))
}
